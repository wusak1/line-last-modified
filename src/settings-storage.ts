import type { LineLastModifiedSettings, VaultSettings } from './types';
import { DEFAULT_SETTINGS } from './types';

export const LOCAL_DEVICE_STATE_KEY = 'line-last-modified-device-state-v1';

export interface LocalDeviceState {
	version: 1 | 2;
	gitExecutablePath: string;
	gitRepositoryPath: string;
	deviceId: string;
	deviceName: string;
	devicePlatform: LineLastModifiedSettings['devicePlatform'];
	deviceCreatedAt: string;
	localSequence: number;
	trustedSigningKeyIds: string[];
	revokedSigningKeyIds: string[];
	contentHashKey: string;
}

export function localDeviceStateFromSettings(settings: LineLastModifiedSettings): LocalDeviceState {
	return {
		version: 2,
		gitExecutablePath: settings.gitExecutablePath,
		gitRepositoryPath: settings.gitRepositoryPath,
		deviceId: settings.deviceId,
		deviceName: settings.deviceName,
		devicePlatform: settings.devicePlatform,
		deviceCreatedAt: settings.deviceCreatedAt,
		localSequence: settings.localSequence,
		trustedSigningKeyIds: settings.trustedSigningKeyIds,
		revokedSigningKeyIds: settings.revokedSigningKeyIds,
		contentHashKey: settings.contentHashKey,
	};
}

export function settingsForVaultData(settings: LineLastModifiedSettings): VaultSettings {
	const {
		gitExecutablePath: _gitExecutablePath,
		gitRepositoryPath: _gitRepositoryPath,
		deviceId: _deviceId,
		deviceName: _deviceName,
		devicePlatform: _devicePlatform,
		deviceCreatedAt: _deviceCreatedAt,
		localSequence: _localSequence,
		trustedSigningKeyIds: _trustedSigningKeyIds,
		revokedSigningKeyIds: _revokedSigningKeyIds,
		contentHashKey: _contentHashKey,
		...vaultSettings
	} = settings;
	return vaultSettings;
}

export function mergeStoredSettings(
	vaultSettings: Partial<LineLastModifiedSettings> | undefined,
	localState: Partial<LocalDeviceState> | null,
): LineLastModifiedSettings {
	const safeVaultSettings = settingsForVaultData({ ...DEFAULT_SETTINGS, ...(vaultSettings ?? {}) });
	const merged: LineLastModifiedSettings = { ...DEFAULT_SETTINGS, ...safeVaultSettings };
	if (!localState) return merged;
	return {
		...merged,
		gitExecutablePath: localState.gitExecutablePath ?? merged.gitExecutablePath,
		gitRepositoryPath: localState.gitRepositoryPath ?? merged.gitRepositoryPath,
		deviceId: localState.deviceId ?? merged.deviceId,
		deviceName: localState.deviceName ?? merged.deviceName,
		devicePlatform: localState.devicePlatform ?? merged.devicePlatform,
		deviceCreatedAt: localState.deviceCreatedAt ?? merged.deviceCreatedAt,
		localSequence: localState.localSequence ?? merged.localSequence,
		trustedSigningKeyIds: localState.trustedSigningKeyIds ?? merged.trustedSigningKeyIds,
		revokedSigningKeyIds: localState.revokedSigningKeyIds ?? merged.revokedSigningKeyIds,
		contentHashKey: localState.contentHashKey ?? merged.contentHashKey,
	};
}
