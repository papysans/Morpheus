import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
    children: ReactNode
}

interface State {
    hasError: boolean
    error: Error | null
}

export default class ErrorBoundary extends Component<Props, State> {
    constructor(props: Props) {
        super(props)
        this.state = { hasError: false, error: null }
    }

    static getDerivedStateFromError(error: Error): State {
        return { hasError: true, error }
    }

    componentDidCatch(error: Error, info: ErrorInfo) {
        console.error('[ErrorBoundary]', error, info.componentStack)
    }

    handleReload = () => {
        window.location.reload()
    }

    render() {
        if (this.state.hasError) {
            return (
                <div className="card" style={{ margin: '2rem auto', maxWidth: 480, textAlign: 'center', padding: '2rem' }}>
                    <h2 style={{ marginBottom: '0.5rem' }}>页面加载失败</h2>
                    <p style={{ color: 'var(--text-secondary)', marginBottom: '1.5rem' }}>
                        {this.state.error?.message || '发生未知错误'}
                    </p>
                    <button className="btn-primary" onClick={this.handleReload}>
                        重新加载
                    </button>
                </div>
            )
        }

        return this.props.children
    }
}
