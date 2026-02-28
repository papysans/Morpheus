import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useProjectStore } from '../stores/useProjectStore'
import { useToastStore } from '../stores/useToastStore'
import PageTransition from '../components/ui/PageTransition'
import Skeleton from '../components/ui/Skeleton'
import ProjectCreateModal from '../components/project/ProjectCreateModal'

export default function ProjectList() {
  const { projects, loading, projectsError, fetchProjects, deleteProject, deleteProjects, importProject } = useProjectStore()
  const addToast = useToastStore((s) => s.addToast)
  const navigate = useNavigate()

  const [showModal, setShowModal] = useState(false)
  const [searchKeyword, setSearchKeyword] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [selectedProjectIds, setSelectedProjectIds] = useState<string[]>([])
  const [importLoading, setImportLoading] = useState(false)
  const importInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    fetchProjects()
  }, [fetchProjects])

  const statusOptions = useMemo(
    () => Array.from(new Set(projects.map((project) => project.status))).sort(),
    [projects],
  )

  const filteredProjects = useMemo(() => {
    const keyword = searchKeyword.trim().toLowerCase()
    return projects.filter((project) => {
      const matchesKeyword =
        keyword.length === 0 ||
        project.name.toLowerCase().includes(keyword) ||
        project.genre.toLowerCase().includes(keyword) ||
        project.style.toLowerCase().includes(keyword)
      const matchesStatus = statusFilter === 'all' || project.status === statusFilter
      return matchesKeyword && matchesStatus
    })
  }, [projects, searchKeyword, statusFilter])

  const filteredProjectIds = useMemo(() => filteredProjects.map((project) => project.id), [filteredProjects])
  const selectedInFilteredCount = useMemo(() => {
    const filteredIdSet = new Set(filteredProjectIds)
    return selectedProjectIds.filter((id) => filteredIdSet.has(id)).length
  }, [filteredProjectIds, selectedProjectIds])

  const totals = useMemo(
    () => ({
      projects: filteredProjects.length,
      chapters: filteredProjects.reduce((sum, p) => sum + p.chapter_count, 0),
      entities: filteredProjects.reduce((sum, p) => sum + p.entity_count, 0),
      events: filteredProjects.reduce((sum, p) => sum + p.event_count, 0),
    }),
    [filteredProjects],
  )

  useEffect(() => {
    const existingIds = new Set(projects.map((project) => project.id))
    setSelectedProjectIds((prev) => prev.filter((id) => existingIds.has(id)))
  }, [projects])

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    try {
      await deleteProject(id)
      addToast('success', '项目已删除')
    } catch {
      addToast('error', '删除项目失败，请重试')
    }
  }

  const toggleProjectSelection = (id: string, selected: boolean) => {
    setSelectedProjectIds((prev) => {
      const current = new Set(prev)
      if (selected) {
        current.add(id)
      } else {
        current.delete(id)
      }
      return Array.from(current)
    })
  }

  const handleSelectAllFiltered = () => {
    const allFilteredSelected =
      filteredProjectIds.length > 0 && filteredProjectIds.every((id) => selectedProjectIds.includes(id))
    setSelectedProjectIds((prev) => {
      const current = new Set(prev)
      if (allFilteredSelected) {
        filteredProjectIds.forEach((id) => current.delete(id))
      } else {
        filteredProjectIds.forEach((id) => current.add(id))
      }
      return Array.from(current)
    })
  }

  const handleBatchDelete = async () => {
    if (selectedProjectIds.length === 0) {
      return
    }
    const confirmed = window.confirm(`确认删除已选中的 ${selectedProjectIds.length} 个项目？此操作不可恢复。`)
    if (!confirmed) {
      return
    }
    try {
      const result = await deleteProjects(selectedProjectIds)
      setSelectedProjectIds(result.failed_ids)

      if (result.failed_count === 0 && result.deleted_count > 0) {
        addToast('success', `批量删除完成：已删除 ${result.deleted_count} 个项目`)
        return
      }
      if (result.deleted_count > 0 || result.missing_count > 0) {
        addToast(
          'warning',
          `部分完成：删除 ${result.deleted_count}，缺失 ${result.missing_count}，失败 ${result.failed_count}`,
        )
        return
      }
      addToast('error', '批量删除失败，请重试')
    } catch {
      addToast('error', '批量删除失败，请重试')
    }
  }

  const handleImportClick = () => {
    importInputRef.current?.click()
  }

  const handleImportFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    setImportLoading(true)
    try {
      const result = await importProject(file)
      addToast('success', `项目「${result.name}」导入成功，共 ${result.chapter_count} 章`)
    } catch (error: any) {
      const detail = error?.response?.data?.detail
      addToast('error', typeof detail === 'string' ? detail : '导入失败，请检查文件格式')
    } finally {
      setImportLoading(false)
    }
  }

  const handleExport = (id: string, name: string, e: React.MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    const a = document.createElement('a')
    a.href = `/api/projects/${id}/export`
    a.download = `${name}.zip`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }
  return (
    <PageTransition>
      <div>
        <div className="page-head">
          <div>
            <h1 className="title">创作项目</h1>
            <p className="subtitle">以多 Agent 编剧室驱动你的长篇小说，保持设定一致与叙事张功。</p>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              ref={importInputRef}
              type="file"
              accept=".zip"
              style={{ display: 'none' }}
              onChange={handleImportFileChange}
              aria-label="选择项目 zip 文件"
            />
            <button
              className="btn btn-secondary"
              onClick={handleImportClick}
              disabled={importLoading}
              aria-label="导入项目"
            >
              {importLoading ? '导入中…' : '导入项目'}
            </button>
            <button className="btn btn-primary" onClick={() => setShowModal(true)}>
              新建项目
            </button>
          </div>
        </div>

        {/* 统计卡片 */}
        <section className="grid-4">
          {loading && projects.length === 0 ? (
            <Skeleton variant="metric-card" count={4} />
          ) : (
            <>
              <div className="card metric-card">
                <div className="metric-label">项目总数</div>
                <div className="metric-value">{totals.projects}</div>
              </div>
              <div className="card metric-card">
                <div className="metric-label">章节总数</div>
                <div className="metric-value">{totals.chapters}</div>
              </div>
              <div className="card metric-card">
                <div className="metric-label">角色实体</div>
                <div className="metric-value">{totals.entities}</div>
              </div>
              <div className="card metric-card">
                <div className="metric-label">事件节点</div>
                <div className="metric-value">{totals.events}</div>
              </div>
            </>
          )}
        </section>

        <section className="list-toolbar card" aria-label="项目筛选工具栏">
          <div className="list-toolbar__filters">
            <input
              className="input"
              value={searchKeyword}
              onChange={(e) => setSearchKeyword(e.target.value)}
              placeholder="搜索项目名称、题材或文风"
              aria-label="搜索项目"
            />
            <select
              className="select"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              aria-label="按状态筛选"
            >
              <option value="all">全部状态</option>
              {statusOptions.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
            {(searchKeyword || statusFilter !== 'all') && (
              <button
                className="btn btn-secondary"
                onClick={() => {
                  setSearchKeyword('')
                  setStatusFilter('all')
                }}
              >
                清空筛选
              </button>
            )}
          </div>
          <div className="list-toolbar__actions">
            <button
              className="btn btn-secondary"
              onClick={handleSelectAllFiltered}
              disabled={filteredProjects.length === 0}
            >
              {filteredProjects.length > 0 && selectedInFilteredCount === filteredProjects.length
                ? '取消全选当前筛选'
                : `全选当前筛选 (${filteredProjects.length})`}
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => setSelectedProjectIds([])}
              disabled={selectedProjectIds.length === 0}
            >
              清空选择
            </button>
            <button
              className="danger-btn"
              onClick={handleBatchDelete}
              disabled={selectedProjectIds.length === 0}
            >
              批量删除 ({selectedProjectIds.length})
            </button>
            <span className="chip">显示 {filteredProjects.length} / {projects.length}</span>
          </div>
        </section>

        {/* 项目列表 */}
        <section className="project-list-grid">
          {loading && projects.length === 0 ? (
            <Skeleton variant="card" count={3} />
          ) : projectsError && projects.length === 0 ? (
            <div className="card" style={{ padding: 20 }}>
              <p style={{ margin: 0 }}>{projectsError}</p>
              <button
                className="btn btn-secondary"
                style={{ marginTop: 12 }}
                onClick={() => void fetchProjects({ force: true })}
              >
                重新加载
              </button>
            </div>
          ) : projects.length === 0 ? (
            <div className="card" style={{ padding: 20 }}>
              <p className="muted" style={{ margin: 0 }}>
                还没有项目。先创建一个小说工程，然后进入章节工作台开始生成蓝图和草稿。
              </p>
            </div>
          ) : filteredProjects.length === 0 ? (
            <div className="card" style={{ padding: 20 }}>
              <p className="muted" style={{ margin: 0 }}>
                当前筛选条件下没有匹配项目，尝试调整关键词或状态。
              </p>
            </div>
          ) : (
            filteredProjects.map((project) => (
              <div
                key={project.id}
                className={`card project-card ${selectedProjectIds.includes(project.id) ? 'project-card--selected' : ''}`}
                style={{ padding: 18, cursor: 'pointer' }}
                onClick={() => navigate(`/project/${project.id}`)}
                role="link"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.target !== e.currentTarget) return
                  if (e.key === 'Enter' || e.key === ' ') navigate(`/project/${project.id}`)
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                  <div>
                    <label
                      className="project-card__select"
                      onClick={(e) => {
                        e.stopPropagation()
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={selectedProjectIds.includes(project.id)}
                        onChange={(e) => toggleProjectSelection(project.id, e.target.checked)}
                        aria-label={`选择项目 ${project.name}`}
                      />
                      选择
                    </label>
                    <h2
                      style={{
                        margin: 0,
                        fontWeight: 600,
                        letterSpacing: '-0.02em',
                        fontSize: '1.18rem',
                      }}
                    >
                      {project.name}
                    </h2>
                    <p className="muted" style={{ marginTop: 6, marginBottom: 0 }}>
                      {project.genre} · {project.style}
                    </p>
                    {project.created_at && (
                      <p className="muted" style={{ marginTop: 4, marginBottom: 0, fontSize: '0.78rem' }}>
                        创建于 {new Date(project.created_at).toLocaleDateString()}
                      </p>
                    )}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span className="chip">{project.status}</span>
                    <button
                      className="btn btn-secondary"
                      style={{ padding: '4px 10px', fontSize: '0.8rem' }}
                      onClick={(e) => handleExport(project.id, project.name, e)}
                      aria-label={`导出项目 ${project.name}`}
                    >
                      导出
                    </button>
                    <button
                      className="btn btn-secondary"
                      style={{ padding: '4px 10px', fontSize: '0.8rem' }}
                      onClick={(e) => handleDelete(project.id, e)}
                    >
                      删除
                    </button>
                  </div>
                </div>

                <div
                  style={{
                    marginTop: 14,
                    display: 'grid',
                    gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
                    gap: 10,
                  }}
                >
                  <div className="card-strong" style={{ padding: 10 }}>
                    <div className="metric-label">章节</div>
                    <div style={{ marginTop: 4, fontWeight: 700 }}>{project.chapter_count}</div>
                  </div>
                  <div className="card-strong" style={{ padding: 10 }}>
                    <div className="metric-label">角色</div>
                    <div style={{ marginTop: 4, fontWeight: 700 }}>{project.entity_count}</div>
                  </div>
                  <div className="card-strong" style={{ padding: 10 }}>
                    <div className="metric-label">事件</div>
                    <div style={{ marginTop: 4, fontWeight: 700 }}>{project.event_count}</div>
                  </div>
                </div>
              </div>
            ))
          )}
        </section>

        <ProjectCreateModal open={showModal} onClose={() => setShowModal(false)} />
      </div>
    </PageTransition>
  )
}
