/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as platform from '../../../../base/common/platform.js';
import { URI } from '../../../../base/common/uri.js';
import { tauriInvoke } from '../../../../base/parts/sandbox/tauri-browser/globals.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { ILoggerService, ILogService } from '../../../../platform/log/common/log.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IUserDataProfilesService } from '../../../../platform/userDataProfile/common/userDataProfile.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { IBrowserWorkbenchEnvironmentService } from '../../environment/browser/environmentService.js';
import { IExtensionHostInitData, UIKind } from '../common/extensionHostProtocol.js';
import { ExtensionHostExtensions } from '../common/extensions.js';

export interface ITauriExtensionHostInitDataServices {
	readonly contextService: IWorkspaceContextService;
	readonly environmentService: IBrowserWorkbenchEnvironmentService;
	readonly userDataProfilesService: IUserDataProfilesService;
	readonly telemetryService: ITelemetryService;
	readonly logService: ILogService;
	readonly loggerService: ILoggerService;
	readonly labelService: ILabelService;
	readonly productService: IProductService;
}

export async function createTauriExtensionHostInitData(
	services: ITauriExtensionHostInitDataServices,
	extensions: ExtensionHostExtensions,
	autoStart: boolean
): Promise<IExtensionHostInitData> {
	const workspace = services.contextService.getWorkspace();
	const environment = services.environmentService;
	const product = services.productService;
	const configuration = await tauriInvoke<{ appRoot: string }>('resolve_window_configuration');

	return {
		commit: product.commit,
		version: product.version,
		quality: product.quality,
		date: product.date,
		parentPid: 0,
		environment: {
			isExtensionDevelopmentDebug: false,
			appRoot: URI.file(configuration.appRoot),
			appName: product.nameLong,
			appHost: product.embedderIdentifier || 'tauri',
			appUriScheme: product.urlProtocol || 'code-tauri',
			isExtensionTelemetryLoggingOnly: false,
			appLanguage: platform.language,
			extensionDevelopmentLocationURI: environment.extensionDevelopmentLocationURI,
			extensionTestsLocationURI: environment.extensionTestsLocationURI,
			globalStorageHome: services.userDataProfilesService.defaultProfile.globalStorageHome,
			workspaceStorageHome: environment.workspaceStorageHome,
			isSessionsWindow: false,
			skipWorkspaceStorageLock: true
		},
		workspace: services.contextService.getWorkbenchState() === WorkbenchState.EMPTY ? undefined : {
			configuration: workspace.configuration ?? undefined,
			id: workspace.id,
			name: services.labelService.getWorkspaceLabel(workspace),
			isUntitled: false,
			transient: workspace.transient
		},
		remote: {
			authority: environment.remoteAuthority,
			connectionData: null,
			isRemote: false
		},
		consoleForward: {
			includeStack: true,
			logNative: false
		},
		extensions: extensions.toSnapshot(),
		telemetryInfo: {
			sessionId: services.telemetryService.sessionId,
			machineId: services.telemetryService.machineId,
			sqmId: services.telemetryService.sqmId,
			devDeviceId: services.telemetryService.devDeviceId ?? services.telemetryService.machineId,
			firstSessionDate: services.telemetryService.firstSessionDate,
			msftInternal: services.telemetryService.msftInternal
		},
		remoteExtensionTips: product.remoteExtensionTips,
		virtualWorkspaceExtensionTips: product.virtualWorkspaceExtensionTips,
		logLevel: services.logService.getLevel(),
		loggers: [...services.loggerService.getRegisteredLoggers()],
		logsLocation: environment.extHostLogsPath,
		autoStart,
		uiKind: UIKind.Desktop
	};
}
