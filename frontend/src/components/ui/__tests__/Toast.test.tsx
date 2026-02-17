import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, act, fireEvent } from '@testing-library/react'
import Toast from '../Toast'
import { useToastStore, ToastItem } from '../../../stores/useToastStore'

function makeToast(overrides: Partial<ToastItem> = {}): ToastItem {
    return {
        id: 'test-1',
        type: 'success',
        message: '操作成功',
        duration: 3000,
        ...overrides,
    }
}

beforeEach(() => {
    useToastStore.setState({ toasts: [] })
    vi.useFakeTimers()
})

afterEach(() => {
    vi.useRealTimers()
})

describe('Toast component', () => {
    it('renders message and has role="alert"', () => {
        render(<Toast toast={makeToast()} />)
        expect(screen.getByRole('alert')).toBeInTheDocument()
        expect(screen.getByText('操作成功')).toBeInTheDocument()
    })

    it('applies type-specific CSS class', () => {
        const { container } = render(<Toast toast={makeToast({ type: 'error' })} />)
        expect(container.querySelector('.toast--error')).toBeTruthy()
    })

    it('auto-dismisses after duration', () => {
        const toast = makeToast({ id: 'auto-dismiss', duration: 3000 })
        useToastStore.setState({ toasts: [toast] })

        render(<Toast toast={toast} />)

        act(() => {
            vi.advanceTimersByTime(3000)
        })

        expect(useToastStore.getState().toasts.find((t) => t.id === 'auto-dismiss')).toBeUndefined()
    })

    it('removes toast on close button click', () => {
        const toast = makeToast({ id: 'close-me' })
        useToastStore.setState({ toasts: [toast] })

        render(<Toast toast={toast} />)

        fireEvent.click(screen.getByLabelText('关闭通知'))

        expect(useToastStore.getState().toasts.find((t) => t.id === 'close-me')).toBeUndefined()
    })

    it('renders correct icon per type', () => {
        const { rerender } = render(<Toast toast={makeToast({ type: 'success' })} />)
        expect(screen.getByText('✓')).toBeInTheDocument()

        rerender(<Toast toast={makeToast({ type: 'error' })} />)
        expect(screen.getByText('✕')).toBeInTheDocument()

        rerender(<Toast toast={makeToast({ type: 'info' })} />)
        expect(screen.getByText('ℹ')).toBeInTheDocument()

        rerender(<Toast toast={makeToast({ type: 'warning' })} />)
        expect(screen.getByText('⚠')).toBeInTheDocument()
    })

    // --- Enhanced Toast tests (Requirements 4.1, 4.2, 4.3) ---

    it('renders context prefix when provided', () => {
        render(<Toast toast={makeToast({ context: '创建章节' })} />)
        expect(screen.getByText('创建章节:')).toBeInTheDocument()
        expect(screen.getByText('操作成功')).toBeInTheDocument()
    })

    it('renders action buttons when provided', () => {
        const onClick = vi.fn()
        render(<Toast toast={makeToast({
            actions: [{ label: '重试', onClick }],
        })} />)
        expect(screen.getByText('重试')).toBeInTheDocument()
    })

    it('clicking action button calls onClick', () => {
        const onClick = vi.fn()
        render(<Toast toast={makeToast({
            actions: [{ label: '重试', onClick }],
        })} />)
        fireEvent.click(screen.getByText('重试'))
        expect(onClick).toHaveBeenCalledOnce()
    })

    it('shows detail toggle when detail provided', () => {
        render(<Toast toast={makeToast({ detail: 'Error stack trace...' })} />)
        expect(screen.getByText('查看详情')).toBeInTheDocument()
        expect(screen.queryByText('Error stack trace...')).not.toBeInTheDocument()
    })

    it('clicking detail toggle shows/hides detail text', () => {
        render(<Toast toast={makeToast({ detail: 'Error stack trace...' })} />)

        fireEvent.click(screen.getByText('查看详情'))
        expect(screen.getByText('Error stack trace...')).toBeInTheDocument()
        expect(screen.getByText('收起详情')).toBeInTheDocument()

        fireEvent.click(screen.getByText('收起详情'))
        expect(screen.queryByText('Error stack trace...')).not.toBeInTheDocument()
        expect(screen.getByText('查看详情')).toBeInTheDocument()
    })

    it('toast with actions does not auto-dismiss', () => {
        const toast = makeToast({
            id: 'sticky',
            duration: 3000,
            actions: [{ label: '重试', onClick: vi.fn() }],
        })
        useToastStore.setState({ toasts: [toast] })

        render(<Toast toast={toast} />)

        act(() => {
            vi.advanceTimersByTime(10000)
        })

        // Toast should still be in the store
        expect(useToastStore.getState().toasts.find((t) => t.id === 'sticky')).toBeDefined()
    })
})
