import { useCallback, useEffect, useRef, useState } from 'react'
import { useProjectStore, type ProjectCreateForm } from '../../stores/useProjectStore'
import { useToastStore } from '../../stores/useToastStore'

interface ProjectCreateModalProps {
    open: boolean
    onClose: () => void
}

const defaultForm: ProjectCreateForm = {
    name: '',
    genre: '奇幻',
    style: '冷峻现实主义',
    target_length: 300000,
    taboo_constraints: '',
}

export default function ProjectCreateModal({ open, onClose }: ProjectCreateModalProps) {
    const createProject = useProjectStore((s) => s.createProject)
    const addToast = useToastStore((s) => s.addToast)
    const [creating, setCreating] = useState(false)
    const [form, setForm] = useState<ProjectCreateForm>({ ...defaultForm })
    const nameInputRef = useRef<HTMLInputElement | null>(null)

    const handleCreate = useCallback(async () => {
        if (!form.name.trim()) return
        setCreating(true)
        try {
            await createProject(form)
            setForm({ ...defaultForm })
            addToast('success', '项目创建成功')
            onClose()
        } catch {
            addToast('error', '项目创建失败，请重试')
        } finally {
            setCreating(false)
        }
    }, [form, createProject, addToast, onClose])

    useEffect(() => {
        if (!open) return
        const timer = window.setTimeout(() => nameInputRef.current?.focus(), 0)
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape' && !creating) {
                onClose()
            }
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'enter') {
                event.preventDefault()
                void handleCreate()
            }
        }
        window.addEventListener('keydown', onKeyDown)
        return () => {
            window.clearTimeout(timer)
            window.removeEventListener('keydown', onKeyDown)
        }
    }, [open, creating, onClose, handleCreate])

    if (!open) return null

    return (
        <div className="modal-backdrop" aria-modal="true" role="dialog">
            <div className="card modal-card modern-modal">
                <h2 style={{ marginTop: 0, marginBottom: 12, fontWeight: 600, letterSpacing: '-0.02em' }}>创建小说项目</h2>
                <div style={{ display: 'grid', gap: 12 }}>
                    <label>
                        <div className="metric-label" style={{ marginBottom: 6 }}>项目名称</div>
                        <input
                            className="input"
                            ref={nameInputRef}
                            value={form.name}
                            onChange={(e) => setForm({ ...form, name: e.target.value })}
                            placeholder="例如：霜城编年史"
                        />
                    </label>
                    <label>
                        <div className="metric-label" style={{ marginBottom: 6 }}>题材</div>
                        <select
                            className="select"
                            value={form.genre}
                            onChange={(e) => setForm({ ...form, genre: e.target.value })}
                        >
                            <option>奇幻</option>
                            <option>科幻</option>
                            <option>悬疑</option>
                            <option>历史</option>
                            <option>都市</option>
                        </select>
                    </label>
                    <label>
                        <div className="metric-label" style={{ marginBottom: 6 }}>文风契约</div>
                        <input
                            className="input"
                            value={form.style}
                            onChange={(e) => setForm({ ...form, style: e.target.value })}
                        />
                    </label>
                    <label>
                        <div className="metric-label" style={{ marginBottom: 6 }}>目标篇幅</div>
                        <input
                            className="input"
                            type="number"
                            value={form.target_length}
                            onChange={(e) => setForm({ ...form, target_length: Number(e.target.value) })}
                        />
                        <div className="muted" style={{ marginTop: 6, fontSize: '0.78rem' }}>
                            建议区间：80,000 - 500,000 字
                        </div>
                    </label>
                    <label>
                        <div className="metric-label" style={{ marginBottom: 6 }}>禁忌约束（逗号分隔）</div>
                        <input
                            className="input"
                            value={form.taboo_constraints}
                            onChange={(e) => setForm({ ...form, taboo_constraints: e.target.value })}
                            placeholder="例如：主角开局无敌, 角色瞬移解决一切"
                        />
                    </label>
                </div>

                <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                    <button className="btn btn-secondary" onClick={onClose} disabled={creating}>
                        取消
                    </button>
                    <button className="btn btn-primary" onClick={handleCreate} disabled={creating || !form.name.trim()}>
                        {creating ? '创建中...' : '创建项目'}
                    </button>
                </div>
                <p className="muted" style={{ marginTop: 10, marginBottom: 0, fontSize: '0.78rem' }}>
                    快捷键：<kbd>Ctrl/Cmd + Enter</kbd> 创建，<kbd>Esc</kbd> 关闭
                </p>
            </div>
        </div>
    )
}
