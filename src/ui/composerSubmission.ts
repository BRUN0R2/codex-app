export interface ComposerSubmissionState {
  readonly hasDraft: boolean;
  readonly modelSelectionRequired: boolean;
  readonly modelSelectionReady: boolean;
  readonly sending: boolean;
}

export interface ComposerModelWarmupState {
  readonly engineReady: boolean;
  readonly hasDraft: boolean;
}

export function canSubmitComposerMessage(state: ComposerSubmissionState): boolean {
  return (
    state.hasDraft && !state.sending && (!state.modelSelectionRequired || state.modelSelectionReady)
  );
}

export function shouldWarmComposerModelCatalog(state: ComposerModelWarmupState): boolean {
  return state.engineReady && state.hasDraft;
}
