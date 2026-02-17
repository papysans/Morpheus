import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import BatchStateMachine from '../BatchStateMachine'
import type { BatchStateMachineProps } from '../BatchStateMachine'

const noop = vi.fn()

function makeProps(overrides: Partial<BatchStateMachineProps> = {}): BatchStateMachineProps {
    return {
        state: 'idle',
        progress: { completed: 0, total: 10 },
        onPause: noop,
        onResume: noop,
        onStop: noop,
        onRetry: noop,
        onRestart: noop,
        ...overrides,
    }
}

describe('BatchStateMachine', () => {
    it('renders idle state with "等待开始" message', () => {
        render(<BatchStateMachine {...makeProps({ state: 'idle' })} />)
        expect(screen.getByText('等待开始')).toBeInTheDocument()
    })

    it('renders generating state with 暂停/终止 buttons', () => {
        render(<BatchStateMachine {...makeProps({ state: 'generating' })} />)
        expect(screen.getByText('暂停')).toBeInTheDocument()
        expect(screen.getByText('终止')).toBeInTheDocument()
    })

    it('renders paused state with 继续/终止 buttons', () => {
        render(<BatchStateMachine {...makeProps({ state: 'paused' })} />)
        expect(screen.getByText('继续')).toBeInTheDocument()
        expect(screen.getByText('终止')).toBeInTheDocument()
    })

    it('renders interrupted state with error message and 从断点恢复/重新开始 buttons', () => {
        render(<BatchStateMachine {...makeProps({
            state: 'interrupted',
            error: '网络连接中断',
        })} />)
        expect(screen.getByText('网络连接中断')).toBeInTheDocument()
        expect(screen.getByText('从断点恢复')).toBeInTheDocument()
        expect(screen.getByText('重新开始')).toBeInTheDocument()
    })

    it('renders completed state with summary', () => {
        render(<BatchStateMachine {...makeProps({
            state: 'completed',
            progress: { completed: 10, total: 10 },
            summary: { totalWords: 12345, conflictCount: 3 },
        })} />)
        expect(screen.getByText(/12,345/)).toBeInTheDocument()
        expect(screen.getByText(/冲突数: 3/)).toBeInTheDocument()
    })

    it('progress bar shows correct percentage', () => {
        render(<BatchStateMachine {...makeProps({
            state: 'generating',
            progress: { completed: 3, total: 10 },
        })} />)
        expect(screen.getByTestId('batch-progress-text').textContent).toBe('3/10 (30%)')
    })

    it('button click handlers are called correctly', () => {
        const onPause = vi.fn()
        const onStop = vi.fn()
        render(<BatchStateMachine {...makeProps({
            state: 'generating',
            onPause,
            onStop,
        })} />)

        fireEvent.click(screen.getByText('暂停'))
        expect(onPause).toHaveBeenCalledOnce()

        fireEvent.click(screen.getByText('终止'))
        expect(onStop).toHaveBeenCalledOnce()
    })

    it('does not render buttons in idle state', () => {
        render(<BatchStateMachine {...makeProps({ state: 'idle' })} />)
        expect(screen.queryByRole('button')).toBeNull()
    })

    it('does not render buttons in completed state', () => {
        render(<BatchStateMachine {...makeProps({
            state: 'completed',
            progress: { completed: 10, total: 10 },
        })} />)
        expect(screen.queryByRole('button')).toBeNull()
    })
})
