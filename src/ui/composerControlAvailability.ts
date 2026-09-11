export interface ComposerControlAvailability {
  readonly attachments: true;
  readonly permissions: boolean;
}

export function composerControlAvailability(
  configurationAvailable: boolean,
): ComposerControlAvailability {
  return {
    attachments: true,
    permissions: configurationAvailable,
  };
}
