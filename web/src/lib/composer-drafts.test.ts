import { beforeEach, describe, expect, it, vi } from 'vitest'

const STORAGE_KEY = 'hapi:composer-drafts'

describe('composer-drafts', () => {
    beforeEach(() => {
        sessionStorage.clear()
        vi.resetModules()
    })

    it('hydrates existing sessionStorage drafts', async () => {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
            alpha: 'draft one',
            beta: '',
            gamma: 123
        }))

        const { getDraft } = await import('./composer-drafts')

        expect(getDraft('alpha')).toBe('draft one')
        expect(getDraft('beta')).toBe('')
        expect(getDraft('gamma')).toBe('')
    })

    it('saves drafts per session and trims empty values', async () => {
        const { getDraft, saveDraft } = await import('./composer-drafts')

        saveDraft('s1', 'hello')
        saveDraft('s2', 'world')

        expect(getDraft('s1')).toBe('hello')
        expect(getDraft('s2')).toBe('world')
        expect(JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '{}')).toEqual({
            s1: 'hello',
            s2: 'world'
        })

        saveDraft('s1', '   ')

        expect(getDraft('s1')).toBe('')
        expect(getDraft('s2')).toBe('world')
        expect(JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '{}')).toEqual({
            s2: 'world'
        })
    })

    it('clears a single session draft', async () => {
        const { clearDraft, getDraft, saveDraft } = await import('./composer-drafts')

        saveDraft('s1', 'draft A')
        saveDraft('s2', 'draft B')
        clearDraft('s1')

        expect(getDraft('s1')).toBe('')
        expect(getDraft('s2')).toBe('draft B')
        expect(JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '{}')).toEqual({
            s2: 'draft B'
        })
    })

    it('recovers from invalid stored payload', async () => {
        sessionStorage.setItem(STORAGE_KEY, 'not-json')
        const { getDraft, saveDraft } = await import('./composer-drafts')

        expect(getDraft('s1')).toBe('')

        saveDraft('s1', 'new draft')
        expect(getDraft('s1')).toBe('new draft')
        expect(JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '{}')).toEqual({
            s1: 'new draft'
        })
    })
})
