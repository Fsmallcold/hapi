export type StartedBy = 'runner' | 'terminal';

export type LocalLaunchExitReason = 'switch' | 'exit' | 'retry';

export type LocalLaunchContext = {
    startedBy?: StartedBy;
    startingMode?: 'local' | 'remote';
    /** When true, crash returns 'retry' instead of 'switch' (used by Codex/OpenAI sessions). */
    autoResume?: boolean;
};

export function getLocalLaunchExitReason(context: LocalLaunchContext): LocalLaunchExitReason {
    // Auto-resume mode: retry locally instead of switching to remote
    // (remote mode uses Claude API, useless for Codex/OpenAI sessions)
    if (context.autoResume && context.startedBy === 'runner') {
        return 'retry';
    }

    if (context.startedBy === 'runner' || context.startingMode === 'remote') {
        return 'switch';
    }

    return 'exit';
}
