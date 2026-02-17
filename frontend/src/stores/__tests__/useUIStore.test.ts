import { describe, it, expect, beforeEach } from 'vitest'
import { useUIStore } from '../useUIStore'

describe('useUIStore - 阅读模式', () => {
    beforeEach(() => {
        // Reset store to defaults
        useUIStore.setState({
            sidebarCollapsed: false,
            readingMode: false,
            shortcutHelpOpen: false,
            _savedSidebarCollapsed: null,
        })
    })

    it('enterReadingMode 进入阅读模式并折叠侧边栏', () => {
        useUIStore.getState().enterReadingMode()
        const s = useUIStore.getState()
        expect(s.readingMode).toBe(true)
        expect(s.sidebarCollapsed).toBe(true)
        expect(s._savedSidebarCollapsed).toBe(false)
    })

    it('exitReadingMode 退出阅读模式并恢复侧边栏状态', () => {
        useUIStore.getState().enterReadingMode()
        useUIStore.getState().exitReadingMode()
        const s = useUIStore.getState()
        expect(s.readingMode).toBe(false)
        expect(s.sidebarCollapsed).toBe(false)
        expect(s._savedSidebarCollapsed).toBeNull()
    })

    it('侧边栏已折叠时进入再退出阅读模式，侧边栏保持折叠', () => {
        useUIStore.setState({ sidebarCollapsed: true })
        useUIStore.getState().enterReadingMode()
        useUIStore.getState().exitReadingMode()
        expect(useUIStore.getState().sidebarCollapsed).toBe(true)
    })

    it('toggleReadingMode 进入阅读模式', () => {
        useUIStore.getState().toggleReadingMode()
        expect(useUIStore.getState().readingMode).toBe(true)
        expect(useUIStore.getState().sidebarCollapsed).toBe(true)
    })

    it('toggleReadingMode 两次恢复原始状态', () => {
        useUIStore.getState().toggleReadingMode()
        useUIStore.getState().toggleReadingMode()
        const s = useUIStore.getState()
        expect(s.readingMode).toBe(false)
        expect(s.sidebarCollapsed).toBe(false)
    })

    it('enterReadingMode 重复调用不改变已保存的状态', () => {
        useUIStore.getState().enterReadingMode()
        // Call again — should be a no-op
        useUIStore.getState().enterReadingMode()
        const s = useUIStore.getState()
        expect(s.readingMode).toBe(true)
        expect(s._savedSidebarCollapsed).toBe(false)
    })

    it('exitReadingMode 未进入阅读模式时为空操作', () => {
        useUIStore.getState().exitReadingMode()
        const s = useUIStore.getState()
        expect(s.readingMode).toBe(false)
        expect(s.sidebarCollapsed).toBe(false)
    })
})
