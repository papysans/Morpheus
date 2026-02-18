import { useCallback, useEffect, useRef, useState } from 'react'
import { useProjectStore, type ProjectCreateForm } from '../../stores/useProjectStore'
import { useToastStore } from '../../stores/useToastStore'
import { api } from '../../lib/api'

interface ProjectCreateModalProps {
    open: boolean
    onClose: () => void
}

const GENRE_PRESETS = ['奇幻', '科幻', '悬疑', '历史', '都市']

interface StoryTemplate {
    id: string
    name: string
    category: string
    description: string
    genre_suggestion?: string
    style_suggestion?: string
    default_taboos?: string[]
    prompt_hint?: string
    recommended?: {
        target_length?: number
        chapter_count?: number
        words_per_chapter?: number
        chapter_range?: [number, number]
    }
}

const defaultForm: ProjectCreateForm = {
    name: '',
    genre: '奇幻',
    style: '冷峻现实主义',
    template_id: '',
    target_length: 300000,
    taboo_constraints: '',
}

export default function ProjectCreateModal({ open, onClose }: ProjectCreateModalProps) {
    const createProject = useProjectStore((s) => s.createProject)
    const addToast = useToastStore((s) => s.addToast)
    const [creating, setCreating] = useState(false)
    const [form, setForm] = useState<ProjectCreateForm>({ ...defaultForm })
    const [targetLengthInput, setTargetLengthInput] = useState(String(defaultForm.target_length))
    const [templates, setTemplates] = useState<StoryTemplate[]>([])
    const [loadingTemplates, setLoadingTemplates] = useState(false)
    const nameInputRef = useRef<HTMLInputElement | null>(null)
    const handleCreateRef = useRef<() => Promise<void>>(async () => {})

    const handleCreate = useCallback(async () => {
        const parsedTargetLength = Number(targetLengthInput)
        const normalizedTargetLength = Number.isFinite(parsedTargetLength) && parsedTargetLength > 0
            ? parsedTargetLength
            : form.target_length
        const normalizedForm: ProjectCreateForm = {
            ...form,
            name: form.name.trim(),
            genre: form.genre.trim(),
            style: form.style.trim(),
            template_id: form.template_id?.trim() || '',
            taboo_constraints: form.taboo_constraints.trim(),
            target_length: normalizedTargetLength,
        }
        if (!normalizedForm.name || !normalizedForm.genre) return
        setCreating(true)
        try {
            await createProject(normalizedForm)
            setForm({ ...defaultForm })
            setTargetLengthInput(String(defaultForm.target_length))
            addToast('success', '项目创建成功')
            onClose()
        } catch {
            addToast('error', '项目创建失败，请重试')
        } finally {
            setCreating(false)
        }
    }, [form, targetLengthInput, createProject, addToast, onClose])

    useEffect(() => {
        if (!open) return
        const timer = window.setTimeout(() => nameInputRef.current?.focus(), 0)
        return () => {
            window.clearTimeout(timer)
        }
    }, [open])

    useEffect(() => {
        if (!open || templates.length > 0 || loadingTemplates) return
        setLoadingTemplates(true)
        void api
            .get('/story-templates')
            .then((res) => {
                const items = Array.isArray(res?.data?.templates) ? (res.data.templates as StoryTemplate[]) : []
                setTemplates(items)
            })
            .catch(() => {
                setTemplates([])
            })
            .finally(() => {
                setLoadingTemplates(false)
            })
    }, [open, templates.length, loadingTemplates])

    useEffect(() => {
        setTargetLengthInput(String(form.target_length))
    }, [form.target_length])

    useEffect(() => {
        handleCreateRef.current = handleCreate
    }, [handleCreate])

    useEffect(() => {
        if (!open) return
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape' && !creating) {
                onClose()
            }
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'enter') {
                event.preventDefault()
                void handleCreateRef.current()
            }
        }
        window.addEventListener('keydown', onKeyDown)
        return () => {
            window.removeEventListener('keydown', onKeyDown)
        }
    }, [open, creating, onClose])

    if (!open) return null

    const selectedTemplate = templates.find((item) => item.id === form.template_id)

    const applyTemplateDefaults = () => {
        if (!selectedTemplate) return
        setForm((prev) => {
            const mergedTaboos = new Set(
                prev.taboo_constraints
                    .split(',')
                    .map((item) => item.trim())
                    .filter(Boolean),
            )
            for (const item of selectedTemplate.default_taboos || []) {
                mergedTaboos.add(item)
            }
            const nextTargetLength = selectedTemplate.recommended?.target_length ?? prev.target_length
            const genreShouldFill = !prev.genre.trim() || prev.genre.trim() === defaultForm.genre
            const styleShouldFill = !prev.style.trim() || prev.style.trim() === defaultForm.style
            return {
                ...prev,
                genre: genreShouldFill ? (selectedTemplate.genre_suggestion || prev.genre) : prev.genre,
                style: styleShouldFill ? (selectedTemplate.style_suggestion || prev.style) : prev.style,
                target_length: nextTargetLength,
                taboo_constraints: Array.from(mergedTaboos).join(', '),
            }
        })
        if (selectedTemplate.recommended?.target_length) {
            setTargetLengthInput(String(selectedTemplate.recommended.target_length))
        }
        addToast('info', `已应用模板建议：${selectedTemplate.name}`)
    }

    return (
        <div className="modal-backdrop" aria-modal="true" role="dialog">
            <div className="card modal-card modern-modal">
                <h2 style={{ marginTop: 0, marginBottom: 12, fontWeight: 600, letterSpacing: '-0.02em' }}>创建小说项目</h2>
                <div style={{ display: 'grid', gap: 12 }}>
                    <label>
                        <div className="metric-label" style={{ marginBottom: 6 }}>创作模板</div>
                        <select
                            className="select"
                            value={form.template_id || ''}
                            onChange={(e) => setForm({ ...form, template_id: e.target.value })}
                        >
                            <option value="">不使用模板（自由创作）</option>
                            {templates.map((template) => (
                                <option key={template.id} value={template.id}>
                                    {template.name}
                                </option>
                            ))}
                        </select>
                        {loadingTemplates && (
                            <div className="muted" style={{ marginTop: 6, fontSize: '0.78rem' }}>
                                正在加载模板…
                            </div>
                        )}
                        {selectedTemplate && (
                            <div style={{ marginTop: 8 }}>
                                <div className="muted" style={{ fontSize: '0.78rem', lineHeight: 1.5 }}>
                                    {selectedTemplate.description}
                                    {selectedTemplate.recommended?.chapter_range && (
                                        <> · 建议章节 {selectedTemplate.recommended.chapter_range[0]}-{selectedTemplate.recommended.chapter_range[1]} 章</>
                                    )}
                                </div>
                                {selectedTemplate.prompt_hint && (
                                    <div className="muted" style={{ marginTop: 4, fontSize: '0.78rem' }}>
                                        提示：{selectedTemplate.prompt_hint}
                                    </div>
                                )}
                                <button
                                    type="button"
                                    className="chip-btn"
                                    style={{ marginTop: 8 }}
                                    onClick={applyTemplateDefaults}
                                >
                                    应用模板建议
                                </button>
                            </div>
                        )}
                    </label>
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
                        <input
                            className="input"
                            list="project-genre-options"
                            value={form.genre}
                            onChange={(e) => setForm({ ...form, genre: e.target.value })}
                            placeholder="例如：赛博修仙 / 太空歌剧 / 克苏鲁"
                        />
                        <datalist id="project-genre-options">
                            {GENRE_PRESETS.map((genre) => (
                                <option key={genre} value={genre} />
                            ))}
                        </datalist>
                        <div className="muted" style={{ marginTop: 6, fontSize: '0.78rem' }}>
                            可直接输入自定义题材，也可选择常用题材
                        </div>
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
                            value={targetLengthInput}
                            onChange={(e) => {
                                const raw = e.target.value
                                if (!/^\d*$/.test(raw)) return
                                setTargetLengthInput(raw)
                                if (raw === '') return
                                setForm({ ...form, target_length: Number(raw) })
                            }}
                            onBlur={() => {
                                if (targetLengthInput.trim() === '') {
                                    setTargetLengthInput(String(form.target_length))
                                }
                            }}
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
                    <button className="btn btn-primary" onClick={handleCreate} disabled={creating || !form.name.trim() || !form.genre.trim()}>
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
