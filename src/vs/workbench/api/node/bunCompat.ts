export const isBun = typeof process.versions.bun === 'string';

export function applyBunCompatibilityPatches(): void {
	if (!isBun) {
		return;
	}

	// Bun-specific compatibility patches only.
}
