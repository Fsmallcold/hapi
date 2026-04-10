import { logger } from '@/ui/logger'
import { Future } from '@/utils/future'
import { getLocalLaunchExitReason } from '@/agent/localLaunchPolicy'
import type { LocalLaunchExitReason, StartedBy } from '@/agent/localLaunchPolicy'

type QueueLike = {
    size(): number
    reset(): void
    setOnMessage(callback: ((...args: unknown[]) => void) | null): void
}

type RpcHandlerManagerLike = {
    registerHandler(method: string, handler: () => Promise<void> | void): void
}

export type LocalLauncherControl = {
    abortSignal: AbortSignal
    requestExit: () => void
    requestSwitch: () => void
    getExitReason: () => LocalLaunchExitReason | null
}

export type LocalLauncherOptions = {
    label: string
    failureLabel: string
    queue: QueueLike
    rpcHandlerManager: RpcHandlerManagerLike
    startedBy?: StartedBy
    startingMode?: 'local' | 'remote'
    launch: (signal: AbortSignal, context?: { resumeSessionId?: string }) => Promise<void>
    onLaunchSuccess?: () => Promise<void> | void
    sendFailureMessage: (message: string) => void
    recordLocalLaunchFailure: (message: string, exitReason: LocalLaunchExitReason) => void
    abortLogMessage?: string
    switchLogMessage?: string
    /** Enable auto-resume on crash (for Codex/OpenAI sessions). */
    autoResume?: boolean
    /** Callback to get the session ID for resume after crash. */
    getResumeSessionId?: () => string | null
    /** Max auto-resume retries (default: 5). */
    maxRetries?: number
    /** Min seconds a resumed process must run to be considered stable (default: 30). */
    minStableSeconds?: number
    /** Delay before retrying in ms (default: 3000). */
    retryDelayMs?: number
}

export class BaseLocalLauncher {
    private exitReason: LocalLaunchExitReason | null = null
    private readonly abortController = new AbortController()
    private readonly exitFuture = new Future<void>()

    constructor(private readonly options: LocalLauncherOptions) {}

    get control(): LocalLauncherControl {
        return {
            abortSignal: this.abortController.signal,
            requestExit: this.requestExit,
            requestSwitch: this.requestSwitch,
            getExitReason: () => this.exitReason
        }
    }

    async run(): Promise<LocalLaunchExitReason> {
        const {
            label,
            failureLabel,
            queue,
            rpcHandlerManager,
            startedBy,
            startingMode,
            launch,
            onLaunchSuccess,
            sendFailureMessage,
            recordLocalLaunchFailure,
            abortLogMessage = 'abort requested',
            switchLogMessage = 'switch requested'
        } = this.options

        try {
            const abortProcess = async () => {
                if (!this.abortController.signal.aborted) {
                    this.abortController.abort()
                }
                await this.exitFuture.promise
            }

            const doAbort = async () => {
                logger.debug(`[${label}]: ${abortLogMessage}`)
                this.setExitReason('switch')
                queue.reset()
                await abortProcess()
            }

            const doSwitch = async () => {
                logger.debug(`[${label}]: ${switchLogMessage}`)
                this.setExitReason('switch')
                await abortProcess()
            }

            rpcHandlerManager.registerHandler('abort', doAbort)
            rpcHandlerManager.registerHandler('switch', doSwitch)
            queue.setOnMessage(() => {
                void doSwitch()
            })

            if (this.exitReason) {
                return this.exitReason
            }

            if (queue.size() > 0) {
                return 'switch'
            }

            const maxRetries = this.options.maxRetries ?? 5
            const minStableSeconds = this.options.minStableSeconds ?? 30
            const retryDelayMs = this.options.retryDelayMs ?? 3000
            const autoResume = this.options.autoResume ?? false
            const getResumeSessionId = this.options.getResumeSessionId
            let retryCount = 0

            while (true) {
                if (this.exitReason) {
                    return this.exitReason
                }

                const isRetry = retryCount > 0
                const resumeSessionId = isRetry ? getResumeSessionId?.() ?? undefined : undefined
                logger.debug(`[${label}]: launch${isRetry ? ` (retry ${retryCount}/${maxRetries}, resume=${resumeSessionId ?? 'none'})` : ''}`)
                const launchStart = Date.now()

                try {
                    await launch(this.abortController.signal, { resumeSessionId })
                    if (onLaunchSuccess) {
                        await onLaunchSuccess()
                    }

                    if (!this.exitReason) {
                        this.exitReason = 'exit'
                        break
                    }
                } catch (error) {
                    logger.debug(`[${label}]: launch error`, error)
                    const message = error instanceof Error ? error.message : String(error)
                    const failureMessage = `${failureLabel}: ${message}`
                    const runDurationSec = (Date.now() - launchStart) / 1000

                    const failureExitReason = this.exitReason ?? getLocalLaunchExitReason({
                        startedBy,
                        startingMode,
                        autoResume
                    })

                    // Auto-resume: retry instead of giving up
                    if (failureExitReason === 'retry' && retryCount < maxRetries && !this.exitReason) {
                        // Stability check: if resumed process died too quickly, give up
                        if (isRetry && runDurationSec < minStableSeconds) {
                            logger.error(`[${label}]: Auto-resume stability check failed: ran only ${runDurationSec.toFixed(0)}s < ${minStableSeconds}s threshold. Giving up.`)
                            sendFailureMessage(`${failureMessage} (stability check failed after ${retryCount} retries)`)
                            recordLocalLaunchFailure(message, 'exit')
                            this.exitReason = 'exit'
                            break
                        }

                        retryCount++
                        logger.warn(`[${label}]: Process crashed, auto-resuming (${retryCount}/${maxRetries}, ran ${runDurationSec.toFixed(0)}s): ${message}`)
                        sendFailureMessage(`Process crashed, auto-resuming (${retryCount}/${maxRetries})...`)

                        // Wait before retrying
                        await new Promise(resolve => setTimeout(resolve, retryDelayMs))
                        continue
                    }

                    sendFailureMessage(failureMessage)
                    recordLocalLaunchFailure(message, failureExitReason === 'retry' ? 'exit' : failureExitReason)
                    if (!this.exitReason) {
                        this.exitReason = failureExitReason === 'retry' ? 'exit' : failureExitReason
                    }
                    if (failureExitReason === 'exit') {
                        logger.warn(`[${label}]: ${failureMessage}`)
                    }
                    break
                }
            }
        } finally {
            this.exitFuture.resolve(undefined)
            rpcHandlerManager.registerHandler('abort', async () => {})
            rpcHandlerManager.registerHandler('switch', async () => {})
            queue.setOnMessage(null)
        }

        return this.exitReason || 'exit'
    }

    private requestExit = (): void => {
        this.setExitReason('exit')
        if (!this.abortController.signal.aborted) {
            this.abortController.abort()
        }
    }

    private requestSwitch = (): void => {
        this.setExitReason('switch')
        if (!this.abortController.signal.aborted) {
            this.abortController.abort()
        }
    }

    private setExitReason(reason: LocalLaunchExitReason): void {
        if (!this.exitReason) {
            this.exitReason = reason
        }
    }
}
