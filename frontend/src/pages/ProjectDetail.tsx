import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useProjectStore } from '../stores/useProjectStore'
import { useToastStore } from '../stores/useToastStore'
import { useActivityStore } from '../stores/useActivityStore'
import { useRecentAccessStore } from '../stores/useRecentAccessStore'
import PageTransition from '../components/ui/PageTransition'
import Skeleton from '../components/ui/Skeleton'
import { api } from '../lib/api'
import { exportBook, type ChapterContent } from '../services/exportService'
import DisabledTooltip from '../components/ui/DisabledTooltip'
import { validateField, type FieldError } from '../utils/validation'
import { useConfirmClose } from '../hooks/useConfirmClose'

type OneShotScope = 'volume' | 'book'

export default function ProjectDetail() {
  const { projectId } = useParams<{ projectId: string }>()
  const {
    currentProject,
    chapters,
    loading,
    projectError,
    chaptersError,
    fetchProject,
    fetchChapters,
    invalidateCache,
  } = useProjectStore()
  const addToast = useToastStore((s) => s.addToast)
  const addRecord = useActivityStore((s) => s.addRecord)
  const addAccess = useRecentAccessStore((s) => s.addAccess)

  const [showModal, setShowModal] = useState(false)
  const [creating, setCreating] = useState(false)
  const [exportingBook, setExportingBook] = useState(false)
  const [deletingChapterId, setDeletingChapterId] = useState<string | null>(null)
  const [quickSynopsis, setQuickSynopsis] = useState('')
  const [quickScope, setQuickScope] = useState<OneShotScope>('volume')
  const [form, setForm] = useState({ chapter_number: 1, title: '', goal: '' })
  const [chapterNumberInput, setChapterNumberInput] = useState('1')
  const [fieldErrors, setFieldErrors] = useState<Record<string, FieldError | null>>({})
  const projectReady = Boolean(projectId && currentProject && currentProject.id === projectId)

  const isDirty = form.title !== '' || form.goal !== ''
  const { confirmClose, showConfirm, handleConfirm, handleCancel, message: confirmMessage } = useConfirmClose({ isDirty })

  const handleCloseModal = () => {
    confirmClose(() => {
      setShowModal(false)
      setFieldErrors({})
    })
  }

  useEffect(() => {
    if (!showModal) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        handleCloseModal()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [showModal, isDirty]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleFieldBlur = (field: string, value: string | number, rules: Parameters<typeof validateField>[1]) => {
    const error = validateField(value, rules)
    setFieldErrors((prev) => ({ ...prev, [field]: error }))
  }

  useEffect(() => {
    if (!projectId) return
    fetchProject(projectId)
    fetchChapters(projectId)
  }, [projectId, fetchProject, fetchChapters])

  useEffect(() => {
    if (currentProject && projectId) {
      addAccess({
        type: 'project',
        id: projectId,
        name: currentProject.name,
        path: `/project/${projectId}`,
      })
    }
  }, [currentProject, projectId, addAccess])

  useEffect(() => {
    if (currentProject) {
      const nextChapterNumber = (currentProject.chapter_count ?? 0) + 1
      setForm((prev) => ({ ...prev, chapter_number: nextChapterNumber }))
      setChapterNumberInput(String(nextChapterNumber))
    }
  }, [currentProject])

  const createChapter = async () => {
    if (!projectId || !form.title.trim() || !form.goal.trim()) return
    setCreating(true)
    try {
      await api.post('/chapters', {
        project_id: projectId,
        chapter_number: form.chapter_number,
        title: form.title,
        goal: form.goal,
      })
      setShowModal(false)
      const nextChapterNumber = form.chapter_number + 1
      setForm({ chapter_number: nextChapterNumber, title: '', goal: '' })
      setChapterNumberInput(String(nextChapterNumber))
      setFieldErrors({})
      addToast('success', '章节创建成功')
      addRecord({ type: 'create', description: '创建章节: ' + form.title, status: 'success' })
      invalidateCache('chapters', projectId)
      invalidateCache('project', projectId)
      await fetchProject(projectId, { force: true })
      await fetchChapters(projectId, { force: true })
    } catch (error: any) {
      console.error(error)
      addToast('error', '创建章节失败', {
        context: '创建章节',
        actions: [{ label: '重试', onClick: () => void createChapter() }],
        detail: error?.response?.data?.detail || error?.message,
      })
      addRecord({ type: 'create', description: '创建章节失败', status: 'error', retryAction: () => void createChapter() })
    } finally {
      setCreating(false)
    }
  }

  const buildWritingConsoleLink = () => {
    if (!projectId) return '#'
    const params = new URLSearchParams()
    const prompt = quickSynopsis.trim()
    if (prompt) params.set('prompt', prompt)
    params.set('scope', quickScope)
    const query = params.toString()
    return query ? `/project/${projectId}/write?${query}` : `/project/${projectId}/write`
  }

  const handleExportBook = async () => {
    if (!projectId || !currentProject) return
    if (chapters.length === 0) {
      addToast('warning', '暂无章节可导出')
      return
    }
    setExportingBook(true)
    try {
      const chapterDetails = await Promise.all(
        chapters.map((chapter) => api.get(`/chapters/${chapter.id}`)),
      )
      const exportableChapters: ChapterContent[] = chapterDetails
        .map((response) => response.data)
        .map((chapter) => ({
          chapterNumber: chapter.chapter_number,
          title: chapter.title,
          content: String(chapter.final || chapter.draft || ''),
        }))
      exportBook(exportableChapters, {
        format: 'markdown',
        includeTableOfContents: true,
        projectName: currentProject.name,
      })
      addRecord({ type: 'export', description: '整书导出完成', status: 'success' })
    } catch (error: any) {
      console.error(error)
      addToast('error', '整书导出失败', {
        context: '整书导出',
        actions: [{ label: '重试', onClick: () => void handleExportBook() }],
        detail: error?.response?.data?.detail || error?.message,
      })
      addRecord({ type: 'export', description: '整书导出失败', status: 'error', retryAction: () => void handleExportBook() })
    } finally {
      setExportingBook(false)
    }
  }

  const handleDeleteChapter = async (chapter: typeof chapters[number]) => {
    if (!projectId) return
    const confirmed = window.confirm(`确认删除第 ${chapter.chapter_number} 章《${chapter.title}》？此操作不可恢复。`)
    if (!confirmed) return
    setDeletingChapterId(chapter.id)
    try {
      try {
        await api.delete(`/chapters/${chapter.id}`)
      } catch (error: any) {
        if (error?.response?.status === 405) {
          await api.post(`/chapters/${chapter.id}/delete`)
        } else {
          throw error
        }
      }
      addToast('success', `已删除第 ${chapter.chapter_number} 章`)
      addRecord({ type: 'delete', description: `删除章节: ${chapter.title}`, status: 'success' })
      invalidateCache('chapters', projectId)
      invalidateCache('project', projectId)
      await fetchProject(projectId, { force: true })
      await fetchChapters(projectId, { force: true })
    } catch (error: any) {
      addToast('error', '删除章节失败', {
        context: '章节删除',
        detail: error?.response?.data?.detail || error?.message,
        actions: [{ label: '重试', onClick: () => void handleDeleteChapter(chapter) }],
      })
      addRecord({ type: 'delete', description: '删除章节失败', status: 'error', retryAction: () => void handleDeleteChapter(chapter) })
    } finally {
      setDeletingChapterId(null)
    }
  }

  // Loading skeleton
  if ((loading || (!!currentProject && !projectReady)) && !projectReady) {
    return (
      <PageTransition>
        <div>
          <div className="page-head">
            <div style={{ flex: 1 }}>
              <Skeleton variant="text" />
              <div style={{ marginTop: 10 }}><Skeleton variant="text" /></div>
            </div>
          </div>
          <section className="grid-4">
            <Skeleton variant="metric-card" count={4} />
          </section>
          <div style={{ marginTop: 16 }}>
            <Skeleton variant="card" count={2} />
          </div>
        </div>
      </PageTransition>
    )
  }

  if (!projectReady || !currentProject) {
    return (
      <PageTransition>
        <div className="card" style={{ padding: 18 }}>
          <p className="muted" style={{ margin: 0 }}>
            {projectError || '项目不存在或加载失败'}
          </p>
          <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              className="btn btn-secondary"
              onClick={() => projectId && void fetchProject(projectId, { force: true })}
            >
              重试加载
            </button>
            <Link to="/" className="btn btn-secondary" style={{ display: 'inline-block', textDecoration: 'none' }}>
              返回项目列表
            </Link>
          </div>
        </div>
      </PageTransition>
    )
  }

  return (
    <PageTransition>
      <div>
        <div className="page-head">
          <div>
            <Link to="/" className="muted" style={{ textDecoration: 'none' }}>← 返回项目列表</Link>
            <h1 className="title" style={{ marginTop: 6 }}>{currentProject.name}</h1>
            <p className="subtitle" style={{ marginBottom: 0 }}>
              {currentProject.genre} · {currentProject.style} · 目标 {currentProject.target_length.toLocaleString()} 字
            </p>
          </div>
          <div className="grid-actions">
            <button className="btn btn-secondary" onClick={() => void handleExportBook()} disabled={exportingBook}>
              {exportingBook ? '导出准备中...' : '整书导出'}
            </button>
            <button className="btn btn-primary" onClick={() => setShowModal(true)}>新建章节</button>
          </div>
        </div>

        <section className="grid-4">
          <div className="card metric-card">
            <div className="metric-label">章节总数</div>
            <div className="metric-value">{currentProject.chapter_count}</div>
          </div>
          <div className="card metric-card">
            <div className="metric-label">角色实体</div>
            <div className="metric-value">{currentProject.entity_count}</div>
          </div>
          <div className="card metric-card">
            <div className="metric-label">事件节点</div>
            <div className="metric-value">{currentProject.event_count}</div>
          </div>
          <div className="card metric-card">
            <div className="metric-label">项目状态</div>
            <div className="metric-value" style={{ fontSize: '1.15rem' }}>{currentProject.status}</div>
          </div>
        </section>

        {/* 快捷导航 */}
        <div className="grid-actions" style={{ marginTop: 16 }}>
          <Link to={`/project/${projectId}/write`} className="btn btn-secondary" style={{ textDecoration: 'none' }}>
            创作控制台
          </Link>
          <Link to={`/project/${projectId}/memory`} className="btn btn-secondary" style={{ textDecoration: 'none' }}>
            记忆浏览器
          </Link>
          <Link to={`/project/${projectId}/graph`} className="btn btn-secondary" style={{ textDecoration: 'none' }}>
            知识图谱
          </Link>
          <Link to="/dashboard" className="btn btn-secondary" style={{ textDecoration: 'none' }}>
            评测看板
          </Link>
        </div>

        <section className="card" style={{ padding: 14, marginTop: 16 }}>
          <h2 className="section-title">创作起点</h2>
          <p className="muted" style={{ marginTop: 6, marginBottom: 8 }}>
            项目概览只负责查看状态与章节管理。整卷/整本生成统一在创作控制台进行，避免入口重复。
          </p>
          <textarea
            className="textarea"
            rows={3}
            placeholder="先写一句话梗概，带着它进入创作控制台继续生成。"
            value={quickSynopsis}
            onChange={(e) => setQuickSynopsis(e.target.value)}
          />
          <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <select
              className="input"
              style={{ width: 160 }}
              value={quickScope}
              onChange={(e) => setQuickScope(e.target.value as OneShotScope)}
            >
              <option value="volume">整卷模式</option>
              <option value="book">整本模式</option>
            </select>
            <Link
              to={buildWritingConsoleLink()}
              className="btn btn-primary"
              style={{ textDecoration: 'none' }}
            >
              进入创作控制台
            </Link>
          </div>
        </section>

        {/* 章节列表 */}
        <section className="card" style={{ padding: 14, marginTop: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <h2 className="section-title">章节列表</h2>
            <span className="chip">共 {chapters.length} 章</span>
          </div>
          {chaptersError && (
            <div className="card-strong" style={{ padding: 10, marginBottom: 10 }}>
              <p style={{ margin: 0 }}>{chaptersError}</p>
              <button
                className="btn btn-secondary"
                style={{ marginTop: 8 }}
                onClick={() => projectId && void fetchChapters(projectId, { force: true })}
              >
                重试章节加载
              </button>
            </div>
          )}
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>标题</th>
                  <th>章节目标</th>
                  <th>状态</th>
                  <th>字数</th>
                  <th>冲突数</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {chapters.length === 0 && (
                  <tr>
                    <td colSpan={7} className="muted">
                      暂无章节，先创建第一章并进入章节工作台生成蓝图。
                    </td>
                  </tr>
                )}
                {chapters.map((chapter) => (
                  <tr key={chapter.id}>
                    <td>{chapter.chapter_number}</td>
                    <td>{chapter.title}</td>
                    <td className="line-clamp-2" style={{ maxWidth: 360 }}>{chapter.goal}</td>
                    <td><span className="chip">{chapter.status}</span></td>
                    <td>{chapter.word_count}</td>
                    <td>{chapter.conflict_count}</td>
                    <td>
                      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                        <Link to={`/project/${projectId}/chapter/${chapter.id}`}>进入工作台</Link>
                        <button
                          className="btn btn-secondary"
                          style={{ padding: '4px 10px', fontSize: '0.78rem' }}
                          disabled={deletingChapterId === chapter.id}
                          onClick={() => void handleDeleteChapter(chapter)}
                        >
                          {deletingChapterId === chapter.id ? '删除中...' : '删除'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* 创建章节模态框 */}
        {showModal && (
          <div className="modal-backdrop">
            <div className="card modal-card">
              <h2 style={{ marginTop: 0, marginBottom: 12, fontWeight: 600, letterSpacing: '-0.02em' }}>创建章节</h2>
              <div style={{ display: 'grid', gap: 12 }}>
                <div className="form-group">
                  <label className="form-label">章节编号</label>
                  <input
                    className={`input${fieldErrors.chapter_number ? ' field-error' : ''}`}
                    type="number"
                    value={chapterNumberInput}
                    onChange={(e) => {
                      const raw = e.target.value
                      if (!/^\d*$/.test(raw)) return
                      setChapterNumberInput(raw)
                      if (!raw) return
                      const parsed = Number(raw)
                      if (Number.isFinite(parsed)) {
                        setForm({ ...form, chapter_number: parsed })
                      }
                    }}
                    onBlur={() => {
                      if (!chapterNumberInput.trim()) {
                        setChapterNumberInput(String(form.chapter_number))
                        handleFieldBlur('chapter_number', form.chapter_number, { min: 1, max: 999 })
                        return
                      }
                      const parsed = Number(chapterNumberInput)
                      if (Number.isFinite(parsed)) {
                        setForm({ ...form, chapter_number: parsed })
                        handleFieldBlur('chapter_number', parsed, { min: 1, max: 999 })
                      }
                    }}
                  />
                  {fieldErrors.chapter_number && (
                    <span className="field-message field-message--error">{fieldErrors.chapter_number.message}</span>
                  )}
                </div>
                <div className="form-group">
                  <label className="form-label">章节标题</label>
                  <input
                    className={`input${fieldErrors.title ? ' field-error' : ''}`}
                    value={form.title}
                    onChange={(e) => setForm({ ...form, title: e.target.value })}
                    onBlur={() => handleFieldBlur('title', form.title, { required: true })}
                  />
                  {fieldErrors.title && (
                    <span className="field-message field-message--error">{fieldErrors.title.message}</span>
                  )}
                </div>
                <div className="form-group">
                  <label className="form-label">章节目标</label>
                  <textarea
                    className={`textarea${fieldErrors.goal ? ' field-error' : ''}`}
                    rows={4}
                    value={form.goal}
                    onChange={(e) => setForm({ ...form, goal: e.target.value })}
                    onBlur={() => handleFieldBlur('goal', form.goal, { required: true })}
                  />
                  {fieldErrors.goal && (
                    <span className="field-message field-message--error">{fieldErrors.goal.message}</span>
                  )}
                </div>
              </div>
              <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                <button className="btn btn-secondary" onClick={handleCloseModal} disabled={creating}>
                  取消
                </button>
                <DisabledTooltip reason="请填写标题和章节目标" disabled={!form.title.trim() || !form.goal.trim()}>
                  <button className="btn btn-primary" onClick={createChapter}
                    disabled={creating || !form.title.trim() || !form.goal.trim()}>
                    {creating ? '创建中...' : '创建并进入'}
                  </button>
                </DisabledTooltip>
              </div>
              {showConfirm && (
                <div className="modal-backdrop" style={{ position: 'absolute', inset: 0, borderRadius: 'inherit', zIndex: 10 }}>
                  <div className="card" style={{ padding: 20, textAlign: 'center', maxWidth: 320 }}>
                    <p style={{ margin: '0 0 16px', fontWeight: 500 }}>{confirmMessage}</p>
                    <div style={{ display: 'flex', justifyContent: 'center', gap: 10 }}>
                      <button className="btn btn-secondary" onClick={handleCancel}>继续编辑</button>
                      <button className="btn btn-primary" onClick={handleConfirm}>确定关闭</button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </PageTransition>
  )
}
