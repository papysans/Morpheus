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
import BatchStateMachine from '../components/ui/BatchStateMachine'
import type { BatchState } from '../components/ui/BatchStateMachine'
import { validateField, type FieldError } from '../utils/validation'
import { useConfirmClose } from '../hooks/useConfirmClose'

type OneShotMode = 'studio' | 'quick' | 'cinematic'
type OneShotScope = 'volume' | 'book'

export default function ProjectDetail() {
  const { projectId } = useParams<{ projectId: string }>()
  const { currentProject, chapters, loading, fetchProject, fetchChapters, invalidateCache } = useProjectStore()
  const addToast = useToastStore((s) => s.addToast)
  const addRecord = useActivityStore((s) => s.addRecord)
  const addAccess = useRecentAccessStore((s) => s.addAccess)

  const [showModal, setShowModal] = useState(false)
  const [creating, setCreating] = useState(false)
  const [batchGenerating, setBatchGenerating] = useState(false)
  const [exportingBook, setExportingBook] = useState(false)
  const [batchError, setBatchError] = useState<string | null>(null)
  const [batchResult, setBatchResult] = useState<Array<{
    chapter_number: number; title: string; status: string
  }>>([])
  const [batchForm, setBatchForm] = useState({
    prompt: '',
    mode: 'studio' as OneShotMode,
    scope: 'volume' as OneShotScope,
    chapter_count: 8,
    words_per_chapter: 1600,
    auto_approve: false,
  })
  const [batchState, setBatchState] = useState<BatchState>('idle')
  const [batchProgress, setBatchProgress] = useState({ completed: 0, total: 0 })
  const [batchSummary, setBatchSummary] = useState<{ totalWords: number; conflictCount: number } | undefined>()
  const [form, setForm] = useState({ chapter_number: 1, title: '', goal: '' })
  const [fieldErrors, setFieldErrors] = useState<Record<string, FieldError | null>>({})
  const [batchFieldHints, setBatchFieldHints] = useState<Record<string, string | null>>({})
  const estimatedWords = batchForm.chapter_count * batchForm.words_per_chapter

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

  const handleBatchFieldFocus = (field: string, hint: string) => {
    setBatchFieldHints((prev) => ({ ...prev, [field]: hint }))
  }

  const handleBatchFieldBlur = (field: string, value: number, rules: Parameters<typeof validateField>[1]) => {
    setBatchFieldHints((prev) => ({ ...prev, [field]: null }))
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
      setForm((prev) => ({ ...prev, chapter_number: (currentProject.chapter_count ?? 0) + 1 }))
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
      setForm({ chapter_number: form.chapter_number + 1, title: '', goal: '' })
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

  const generateBook = async () => {
    if (!projectId || !batchForm.prompt.trim()) return
    setBatchGenerating(true)
    setBatchError(null)
    setBatchState('generating')
    setBatchProgress({ completed: 0, total: batchForm.chapter_count })
    try {
      const response = await api.post(`/projects/${projectId}/one-shot-book`, {
        prompt: batchForm.prompt.trim(),
        mode: batchForm.mode,
        scope: batchForm.scope,
        chapter_count: batchForm.chapter_count,
        words_per_chapter: batchForm.words_per_chapter,
        auto_approve: batchForm.auto_approve,
      })
      const chapters = response.data?.chapters || []
      setBatchResult(
        chapters.map((item: any) => ({
          chapter_number: item.chapter_number,
          title: item.title,
          status: item.status,
        })),
      )
      setBatchProgress({ completed: batchForm.chapter_count, total: batchForm.chapter_count })
      setBatchState('completed')
      setBatchSummary({
        totalWords: chapters.reduce((sum: number, ch: any) => sum + (ch.word_count || 0), 0),
        conflictCount: chapters.reduce((sum: number, ch: any) => sum + (ch.conflict_count || 0), 0),
      })
      addToast('success', '整书生成完成')
      addRecord({ type: 'generate', description: '整书生成完成', status: 'success' })
      invalidateCache('chapters', projectId)
      invalidateCache('project', projectId)
      await fetchProject(projectId, { force: true })
      await fetchChapters(projectId, { force: true })
    } catch (error: any) {
      console.error(error)
      const msg = error?.response?.data?.detail || '整卷/整本生成失败'
      setBatchError(msg)
      setBatchState('interrupted')
      addToast('error', '整书生成失败', {
        context: '整书生成',
        actions: [{ label: '重试', onClick: () => void generateBook() }],
        detail: error?.response?.data?.detail || error?.message,
      })
      addRecord({ type: 'generate', description: '整书生成失败', status: 'error', retryAction: () => void generateBook() })
    } finally {
      setBatchGenerating(false)
    }
  }

  const handleBatchPause = () => setBatchState('paused')
  const handleBatchResume = () => setBatchState('generating')
  const handleBatchStop = () => {
    setBatchState('idle')
    setBatchGenerating(false)
    setBatchProgress({ completed: 0, total: 0 })
  }
  const handleBatchRetry = () => {
    setBatchState('generating')
    void generateBook()
  }
  const handleBatchRestart = () => {
    setBatchState('idle')
    setBatchGenerating(false)
    setBatchError(null)
    setBatchProgress({ completed: 0, total: 0 })
    setBatchSummary(undefined)
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

  // Loading skeleton
  if (loading && !currentProject) {
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

  if (!currentProject) {
    return (
      <PageTransition>
        <div className="card" style={{ padding: 18 }}>
          <p className="muted" style={{ margin: 0 }}>项目不存在或加载失败</p>
          <Link to="/" className="btn btn-secondary" style={{ marginTop: 12, display: 'inline-block', textDecoration: 'none' }}>
            返回项目列表
          </Link>
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

        {/* 一句话整卷/整本 */}
        <section className="card" style={{ padding: 14, marginTop: 16 }}>
          <h2 className="section-title">
            一句话整卷 / 整本
          </h2>
          <p className="muted" style={{ marginTop: 6, marginBottom: 6 }}>
            输入一句话梗概，自动拆章并逐章生成全文。预计生成目标约 {estimatedWords.toLocaleString()} 字。
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
            <button
              className={`chip-btn ${batchForm.scope === 'volume' && batchForm.chapter_count === 8 ? 'active' : ''}`}
              onClick={() => setBatchForm((prev) => ({ ...prev, scope: 'volume', chapter_count: 8, words_per_chapter: 1600 }))}
              disabled={batchGenerating}
            >
              标准整卷（8章）
            </button>
            <button
              className={`chip-btn ${batchForm.scope === 'book' && batchForm.chapter_count === 20 ? 'active' : ''}`}
              onClick={() => setBatchForm((prev) => ({ ...prev, scope: 'book', chapter_count: 20, words_per_chapter: 1800 }))}
              disabled={batchGenerating}
            >
              整本冲刺（20章）
            </button>
            <button
              className={`chip-btn ${batchForm.mode === 'quick' ? 'active' : ''}`}
              onClick={() => setBatchForm((prev) => ({ ...prev, mode: 'quick', chapter_count: Math.min(prev.chapter_count, 6) }))}
              disabled={batchGenerating}
            >
              快速试跑
            </button>
          </div>
          <textarea
            className="textarea"
            rows={3}
            placeholder="例如：主角在雪夜被背叛后潜伏反击，最终揪出幕后主使。"
            value={batchForm.prompt}
            onChange={(e) => setBatchForm({ ...batchForm, prompt: e.target.value })}
            disabled={batchGenerating}
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            <select className="input" style={{ width: 170 }} value={batchForm.mode}
              onChange={(e) => setBatchForm({ ...batchForm, mode: e.target.value as OneShotMode })}
              disabled={batchGenerating}>
              <option value="studio">Studio 多Agent</option>
              <option value="quick">Quick 极速</option>
              <option value="cinematic">Cinematic 电影感</option>
            </select>
            <select className="input" style={{ width: 140 }} value={batchForm.scope}
              onChange={(e) => setBatchForm({
                ...batchForm,
                scope: e.target.value as OneShotScope,
                chapter_count: e.target.value === 'book' ? 20 : 8,
              })}
              disabled={batchGenerating}>
              <option value="volume">整卷</option>
              <option value="book">整本</option>
            </select>
            <div className="form-group" style={{ width: 110 }}>
              <input className={`input${fieldErrors.batch_chapter_count?.type === 'error' ? ' field-error' : ''}`} type="number" min={1} max={60}
                value={batchForm.chapter_count}
                onChange={(e) =>
                  setBatchForm({
                    ...batchForm,
                    chapter_count: Math.max(1, Math.min(60, Number(e.target.value) || 1)),
                  })
                }
                onFocus={() => handleBatchFieldFocus('batch_chapter_count', '推荐 8-12 章')}
                onBlur={() => handleBatchFieldBlur('batch_chapter_count', batchForm.chapter_count, { min: 1, max: 60, hint: '推荐 8-12 章' })}
                disabled={batchGenerating} />
              {fieldErrors.batch_chapter_count?.type === 'error' && (
                <span className="field-message field-message--error">{fieldErrors.batch_chapter_count.message}</span>
              )}
              {!fieldErrors.batch_chapter_count && batchFieldHints.batch_chapter_count && (
                <span className="field-message field-message--hint">{batchFieldHints.batch_chapter_count}</span>
              )}
            </div>
            <div className="form-group" style={{ width: 130 }}>
              <input className={`input${fieldErrors.batch_words_per_chapter?.type === 'error' ? ' field-error' : ''}`} type="number" min={300} max={12000}
                value={batchForm.words_per_chapter}
                onChange={(e) =>
                  setBatchForm({
                    ...batchForm,
                    words_per_chapter: Math.max(300, Math.min(12000, Number(e.target.value) || 1600)),
                  })
                }
                onFocus={() => handleBatchFieldFocus('batch_words_per_chapter', '推荐 1200-2000 字')}
                onBlur={() => handleBatchFieldBlur('batch_words_per_chapter', batchForm.words_per_chapter, { min: 300, max: 12000, hint: '推荐 1200-2000 字' })}
                disabled={batchGenerating} />
              {fieldErrors.batch_words_per_chapter?.type === 'error' && (
                <span className="field-message field-message--error">{fieldErrors.batch_words_per_chapter.message}</span>
              )}
              {!fieldErrors.batch_words_per_chapter && batchFieldHints.batch_words_per_chapter && (
                <span className="field-message field-message--hint">{batchFieldHints.batch_words_per_chapter}</span>
              )}
            </div>
            <DisabledTooltip
              reason={batchGenerating ? '正在生成中，请等待完成' : '请先输入创作提示'}
              disabled={batchGenerating || !batchForm.prompt.trim()}
            >
              <button className="btn btn-primary" onClick={generateBook}
                disabled={batchGenerating || !batchForm.prompt.trim()}>
                {batchGenerating ? '批量生成中...' : '一键生成'}
              </button>
            </DisabledTooltip>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
            <input type="checkbox" checked={batchForm.auto_approve}
              onChange={(e) => setBatchForm({ ...batchForm, auto_approve: e.target.checked })}
              disabled={batchGenerating} />
            <span className="muted">无 P0 冲突自动审批</span>
          </label>
          {batchState !== 'idle' && (
            <BatchStateMachine
              state={batchState}
              progress={batchProgress}
              summary={batchSummary}
              error={batchError ?? undefined}
              onPause={handleBatchPause}
              onResume={handleBatchResume}
              onStop={handleBatchStop}
              onRetry={handleBatchRetry}
              onRestart={handleBatchRestart}
            />
          )}
          {batchError && <p style={{ color: 'var(--danger)', marginTop: 10, marginBottom: 0 }}>{batchError}</p>}
          {batchResult.length > 0 && (
            <div style={{ marginTop: 10, display: 'grid', gap: 6 }}>
              {batchResult.slice(0, 8).map((item, index) => (
                <div key={index} className="chip" style={{ justifyContent: 'space-between' }}>
                  <span>第 {item.chapter_number} 章 · {item.title}</span>
                  <span>{item.status}</span>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* 章节列表 */}
        <section className="card" style={{ padding: 14, marginTop: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <h2 className="section-title">章节列表</h2>
            <span className="chip">共 {chapters.length} 章</span>
          </div>
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
                      <Link to={`/project/${projectId}/chapter/${chapter.id}`}>进入工作台</Link>
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
                    value={form.chapter_number}
                    onChange={(e) => setForm({ ...form, chapter_number: Number(e.target.value) })}
                    onBlur={() => handleFieldBlur('chapter_number', form.chapter_number, { min: 1, max: 999 })}
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
