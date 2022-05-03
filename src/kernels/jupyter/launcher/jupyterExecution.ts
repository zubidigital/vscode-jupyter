// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';
import * as urlPath from '../../../platform/vscode-path/resources';
import * as uuid from 'uuid/v4';
import { CancellationToken, Uri } from 'vscode';
import { IWorkspaceService } from '../../../platform/common/application/types';
import { Cancellation } from '../../../platform/common/cancellation';
import { WrappedError } from '../../../platform/errors/types';
import { traceInfo } from '../../../platform/logging';
import { IDisposableRegistry, IConfigurationService, Resource } from '../../../platform/common/types';
import { DataScience } from '../../../platform/common/utils/localize';
import { JupyterSelfCertsError } from '../../../platform/errors/jupyterSelfCertsError';
import { JupyterWaitForIdleError } from '../../../platform/errors/jupyterWaitForIdleError';
import { IInterpreterService } from '../../../platform/interpreter/contracts';
import { PythonEnvironment } from '../../../platform/pythonEnvironments/info';
import { sendTelemetryEvent, captureTelemetry } from '../../../telemetry';
import { Telemetry, Identifiers } from '../../../webviews/webview-side/common/constants';
import { expandWorkingDir, createRemoteConnectionInfo } from '../jupyterUtils';
import { IJupyterConnection } from '../../types';
import {
    IJupyterExecution,
    IJupyterUriProviderRegistration,
    IJupyterServerUri,
    INotebookServerOptions,
    INotebookServer,
    JupyterServerUriHandle,
    INotebookStarter,
    IJupyterSessionManagerFactory,
    IJupyterSessionManager,
    INotebookServerFactory
} from '../types';
import { IJupyterSubCommandExecutionService } from '../types.node';

const LocalHosts = ['localhost', '127.0.0.1', '::1'];

export class JupyterExecutionBase implements IJupyterExecution {
    private usablePythonInterpreter: PythonEnvironment | undefined;
    private disposed: boolean = false;
    private uriToJupyterServerUri = new Map<string, IJupyterServerUri>();
    private pendingTimeouts: (NodeJS.Timeout | number)[] = [];
    constructor(
        private readonly interpreterService: IInterpreterService,
        private readonly disposableRegistry: IDisposableRegistry,
        private readonly workspace: IWorkspaceService,
        private readonly configuration: IConfigurationService,
        private readonly notebookStarter: INotebookStarter | undefined,
        private readonly jupyterInterpreterService: IJupyterSubCommandExecutionService | undefined,
        private readonly jupyterPickerRegistration: IJupyterUriProviderRegistration,
        private readonly jupyterSessionManagerFactory: IJupyterSessionManagerFactory,
        private readonly notebookServerFactory: INotebookServerFactory
    ) {
        this.disposableRegistry.push(this.interpreterService.onDidChangeInterpreter(() => this.onSettingsChanged()));
        this.disposableRegistry.push(this);

        if (workspace) {
            const disposable = workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration('python.dataScience', undefined)) {
                    // When config changes happen, recreate our commands.
                    this.onSettingsChanged();
                }
                if (e.affectsConfiguration('jupyter.jupyterServerType', undefined)) {
                    // When server URI changes, clear our pending URI timeouts
                    this.clearTimeouts();
                }
            });
            this.disposableRegistry.push(disposable);
        }
    }

    public dispose(): Promise<void> {
        this.disposed = true;
        this.clearTimeouts();
        return Promise.resolve();
    }

    public async refreshCommands(): Promise<void> {
        await this.jupyterInterpreterService?.refreshCommands();
    }

    public async isNotebookSupported(cancelToken?: CancellationToken): Promise<boolean> {
        // See if we can find the command notebook
        return this.jupyterInterpreterService ? this.jupyterInterpreterService.isNotebookSupported(cancelToken) : false;
    }

    public async getNotebookError(): Promise<string> {
        return this.jupyterInterpreterService
            ? this.jupyterInterpreterService.getReasonForJupyterNotebookNotBeingSupported()
            : DataScience.webNotSupported();
    }

    public async getUsableJupyterPython(cancelToken?: CancellationToken): Promise<PythonEnvironment | undefined> {
        // Only try to compute this once.
        if (!this.usablePythonInterpreter && !this.disposed && this.jupyterInterpreterService) {
            this.usablePythonInterpreter = await Cancellation.race(
                () => this.jupyterInterpreterService!.getSelectedInterpreter(cancelToken),
                cancelToken
            );
        }
        return this.usablePythonInterpreter;
    }

    /* eslint-disable complexity,  */
    public connectToNotebookServer(
        options: INotebookServerOptions,
        cancelToken: CancellationToken
    ): Promise<INotebookServer> {
        // Return nothing if we cancel
        // eslint-disable-next-line
        return Cancellation.race(async () => {
            let result: INotebookServer | undefined;
            let connection: IJupyterConnection | undefined;
            traceInfo(`Connecting to server`);

            // Try to connect to our jupyter process. Check our setting for the number of tries
            let tryCount = 1;
            const maxTries = Math.max(1, this.configuration.getSettings(undefined).jupyterLaunchRetries);
            let lastTryError: Error;
            while (tryCount <= maxTries && !this.disposed) {
                try {
                    // Start or connect to the process
                    connection = await this.startOrConnect(options, cancelToken);

                    if (!connection.localLaunch && LocalHosts.includes(connection.hostName.toLowerCase())) {
                        sendTelemetryEvent(Telemetry.ConnectRemoteJupyterViaLocalHost);
                    }
                    // eslint-disable-next-line no-constant-condition
                    traceInfo(`Connecting to process server`);

                    // Create a server tha  t we will then attempt to connect to.
                    result = await this.notebookServerFactory.createNotebookServer(connection);
                    traceInfo(`Connection complete server`);

                    sendTelemetryEvent(
                        options.localJupyter ? Telemetry.ConnectLocalJupyter : Telemetry.ConnectRemoteJupyter
                    );
                    return result;
                } catch (err) {
                    lastTryError = err;
                    // Cleanup after ourselves. server may be running partially.
                    if (result) {
                        traceInfo(`Killing server because of error ${err}`);
                        await result.dispose();
                    }
                    if (err instanceof JupyterWaitForIdleError && tryCount < maxTries) {
                        // Special case. This sometimes happens where jupyter doesn't ever connect. Cleanup after
                        // ourselves and propagate the failure outwards.
                        traceInfo('Retry because of wait for idle problem.');

                        // Close existing connection.
                        connection?.dispose();
                        tryCount += 1;
                    } else if (connection) {
                        // If this is occurring during shutdown, don't worry about it.
                        if (this.disposed) {
                            throw err;
                        }

                        // Something else went wrong
                        if (!options.localJupyter) {
                            sendTelemetryEvent(Telemetry.ConnectRemoteFailedJupyter, undefined, undefined, err, true);

                            // Check for the self signed certs error specifically
                            if (err.message.indexOf('reason: self signed certificate') >= 0) {
                                sendTelemetryEvent(Telemetry.ConnectRemoteSelfCertFailedJupyter);
                                throw new JupyterSelfCertsError(connection.baseUrl);
                            } else {
                                throw WrappedError.from(
                                    DataScience.jupyterNotebookRemoteConnectFailed().format(connection.baseUrl, err),
                                    err
                                );
                            }
                        } else {
                            sendTelemetryEvent(Telemetry.ConnectFailedJupyter, undefined, undefined, err, true);
                            throw WrappedError.from(
                                DataScience.jupyterNotebookConnectFailed().format(connection.baseUrl, err),
                                err
                            );
                        }
                    } else {
                        throw err;
                    }
                }
                throw lastTryError;
            }
            throw new Error('Max number of attempts reached');
        }, cancelToken);
    }

    public getServer(_options: INotebookServerOptions): Promise<INotebookServer | undefined> {
        // This is cached at the host or guest level
        return Promise.resolve(undefined);
    }

    public async validateRemoteUri(uri: string): Promise<void> {
        let connection: IJupyterConnection | undefined = undefined;
        let sessionManager: IJupyterSessionManager | undefined = undefined;
        try {
            // Prepare our map of server URIs (needed in order to retrieve the uri during the connection)
            await this.updateServerUri(uri);

            // Create an active connection.
            connection = await createRemoteConnectionInfo(uri, this.getServerUri.bind(this));

            // Attempt to list the running kernels. It will return empty if there are none, but will
            // throw if can't connect.
            sessionManager = await this.jupyterSessionManagerFactory.create(connection, false);
            await sessionManager.getRunningKernels();

            // We should throw an exception if any of that fails.
        } finally {
            if (connection) {
                connection.dispose();
            }
            if (sessionManager) {
                void sessionManager.dispose();
            }
        }
    }

    private async startOrConnect(
        options: INotebookServerOptions,
        cancelToken: CancellationToken
    ): Promise<IJupyterConnection> {
        // If our uri is undefined or if it's set to local launch we need to launch a server locally
        if (options.localJupyter) {
            // If that works, then attempt to start the server
            traceInfo(`Launching server`);
            const useDefaultConfig = !options || options.skipUsingDefaultConfig ? false : true;
            const settings = this.configuration.getSettings(options.resource);

            // Expand the working directory. Create a dummy launching file in the root path (so we expand correctly)
            const workingDirectory = expandWorkingDir(
                options.workingDir,
                this.workspace.rootFolder ? urlPath.joinPath(this.workspace.rootFolder, `${uuid()}.txt`) : undefined,
                this.workspace,
                settings
            );

            const connection = await this.startNotebookServer(
                options.resource,
                useDefaultConfig,
                this.configuration.getSettings(undefined).jupyterCommandLineArguments,
                Uri.file(workingDirectory),
                cancelToken
            );
            if (connection) {
                return connection;
            } else {
                // Throw a cancellation error if we were canceled.
                Cancellation.throwIfCanceled(cancelToken);

                // Otherwise we can't connect
                throw new Error(DataScience.jupyterNotebookFailure().format(''));
            }
        } else {
            // Prepare our map of server URIs
            await this.updateServerUri(options.uri);

            // If we have a URI spec up a connection info for it
            return createRemoteConnectionInfo(options.uri, this.getServerUri.bind(this));
        }
    }

    // eslint-disable-next-line
    @captureTelemetry(Telemetry.StartJupyter)
    private async startNotebookServer(
        resource: Resource,
        useDefaultConfig: boolean,
        customCommandLine: string[],
        workingDirectory: Uri,
        cancelToken: CancellationToken
    ): Promise<IJupyterConnection | undefined> {
        return this.notebookStarter?.start(
            resource,
            useDefaultConfig,
            customCommandLine,
            workingDirectory,
            cancelToken
        );
    }
    private onSettingsChanged() {
        // Clear our usableJupyterInterpreter so that we recompute our values
        this.usablePythonInterpreter = undefined;
    }

    private extractJupyterServerHandleAndId(uri: string): { handle: JupyterServerUriHandle; id: string } | undefined {
        const url: URL = new URL(uri);

        // Id has to be there too.
        const id = url.searchParams.get(Identifiers.REMOTE_URI_ID_PARAM);
        const uriHandle = url.searchParams.get(Identifiers.REMOTE_URI_HANDLE_PARAM);
        return id && uriHandle ? { handle: uriHandle, id } : undefined;
    }

    private clearTimeouts() {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.pendingTimeouts.forEach((t) => clearTimeout(t as any));
        this.pendingTimeouts = [];
    }

    private getServerUri(uri: string): IJupyterServerUri | undefined {
        const idAndHandle = this.extractJupyterServerHandleAndId(uri);
        if (idAndHandle) {
            return this.uriToJupyterServerUri.get(uri);
        }
    }

    private async updateServerUri(uri: string): Promise<void> {
        const idAndHandle = this.extractJupyterServerHandleAndId(uri);
        if (idAndHandle) {
            const serverUri = await this.jupyterPickerRegistration.getJupyterServerUri(
                idAndHandle.id,
                idAndHandle.handle
            );
            this.uriToJupyterServerUri.set(uri, serverUri);
            // See if there's an expiration date
            if (serverUri.expiration) {
                const timeoutInMS = serverUri.expiration.getTime() - Date.now();
                // Week seems long enough (in case the expiration is ridiculous)
                if (timeoutInMS > 0 && timeoutInMS < 604800000) {
                    this.pendingTimeouts.push(setTimeout(() => this.updateServerUri(uri).ignoreErrors(), timeoutInMS));
                }
            }
        }
    }
}