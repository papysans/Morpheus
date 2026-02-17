import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import ActivityPanel from '../ActivityPanel'
import { useActivityStore } from '../../../stores/useActivityStore'

// Mock localStorage since jsdom doesn't provide a full implementation
const localStorageMock = (() => {
    let store: Record<string, string> = {}
    return {
        getItem: vi.fn((key: string) => store[key] ?? null),
        setItem: vi.fn((key: string, value: string) => { store[key] = value }),
        removeItem: vi.fn((key: string) => { delete store[key] }),
        clear: vi.fn(() => { store = {} }),
    }
})()

Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true })

beforeEach(() => {
    localStorageMock.clear()
    vi.clearAllMocks()
    useActivityStore.setState({ records: [], panelOpen: false })
})

describe('ActivityPanel', () => {
    it('renders toggle button with "操作历史" text', () => {
        render(<ActivityPanel />)
        expect(screen.getByText('操作历史')).toBeInTheDocument()
    })

    it('shows record count badge', () => {
        useActivityStore.setState({
            records: [
                { id: '1', type: 'create', description: '创建项目', timestamp: Date.now(), status: 'success' },
                { id: '2', type: 'save', description: '保存章节', timestamp: Date.now(), status: 'success' },
            ],
        })
        render(<ActivityPanel />)
        expect(screen.getByText('2')).toBeInTheDocument()
    })

    it('panel is collapsed by default', () => {
        render(<ActivityPanel />)
        expect(screen.queryByText('暂无操作记录')).not.toBeInTheDocument()
    })

    it('clicking toggle opens the panel', () => {
        render(<ActivityPanel />)
        fireEvent.click(screen.getByText('操作历史'))
        expect(screen.getByText('暂无操作记录')).toBeInTheDocument()
    })

    it('shows "暂无操作记录" when empty and open', () => {
        useActivityStore.setState({ panelOpen: true })
        render(<ActivityPanel />)
        expect(screen.getByText('暂无操作记录')).toBeInTheDocument()
    })

    it('renders records with description and status', () => {
        useActivityStore.setState({
            panelOpen: true,
            records: [
                { id: '1', type: 'generate', description: '生成第一章草稿', timestamp: Date.now(), status: 'success' },
                { id: '2', type: 'export', description: '导出项目', timestamp: Date.now(), status: 'error' },
            ],
        })
        render(<ActivityPanel />)
        expect(screen.getByText('生成第一章草稿')).toBeInTheDocument()
        expect(screen.getByText('导出项目')).toBeInTheDocument()
        expect(screen.getByText('成功')).toBeInTheDocument()
        expect(screen.getByText('失败')).toBeInTheDocument()
    })

    it('shows retry button for error records with retryAction', () => {
        const retryFn = vi.fn()
        useActivityStore.setState({
            panelOpen: true,
            records: [
                { id: '1', type: 'error', description: '操作失败', timestamp: Date.now(), status: 'error', retryAction: retryFn },
            ],
        })
        render(<ActivityPanel />)
        expect(screen.getByText('重试')).toBeInTheDocument()
    })

    it('clicking retry calls retryAction', () => {
        const retryFn = vi.fn()
        useActivityStore.setState({
            panelOpen: true,
            records: [
                { id: '1', type: 'error', description: '操作失败', timestamp: Date.now(), status: 'error', retryAction: retryFn },
            ],
        })
        render(<ActivityPanel />)
        fireEvent.click(screen.getByText('重试'))
        expect(retryFn).toHaveBeenCalledOnce()
    })

    it('clicking clear empties records', () => {
        useActivityStore.setState({
            panelOpen: true,
            records: [
                { id: '1', type: 'create', description: '创建项目', timestamp: Date.now(), status: 'success' },
            ],
        })
        render(<ActivityPanel />)
        expect(screen.getByText('创建项目')).toBeInTheDocument()

        fireEvent.click(screen.getByText('清空'))
        expect(screen.queryByText('创建项目')).not.toBeInTheDocument()
        expect(screen.getByText('暂无操作记录')).toBeInTheDocument()
    })

    it('does not show retry button for error records without retryAction', () => {
        useActivityStore.setState({
            panelOpen: true,
            records: [
                { id: '1', type: 'error', description: '操作失败', timestamp: Date.now(), status: 'error' },
            ],
        })
        render(<ActivityPanel />)
        expect(screen.queryByText('重试')).not.toBeInTheDocument()
    })
})
