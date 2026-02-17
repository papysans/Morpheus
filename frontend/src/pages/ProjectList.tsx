import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useProjectStore } from '../stores/useProjectStore'
import { useToastStore } from '../stores/useToastStore'
import PageTransition from '../components/ui/PageTransition'
import Skeleton from '../components/ui/Skeleton'
import ProjectCreateModal from '../components/project/ProjectCreateModal'

export default function ProjectList() {
  const { projects, loading, fetchProjects, deleteProject } = useProjectStore()
  const addToast = useToastStore((s) => s.addToast)
  const navigate = useNavigate()

  const [showModal, setShowModal] = useState(false)
  const [searchKeyword, setSearchKeyword] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('all')

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

  const totals = useMemo(
    () => ({
      projects: filteredProjects.length,
      chapters: filteredProjects.reduce((sum, p) => sum + p.chapter_count, 0),
      entities: filteredProjects.reduce((sum, p) => sum + p.entity_count, 0),
      events: filteredProjects.reduce((sum, p) => sum + p.event_count, 0),
    }),
    [filteredProjects],
  )

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

  return (
    <PageTransition>
      <div>
        <div className="page-head">
          <div>
            <h1 className="title">创作项目</h1>
            <p className="subtitle">以多 Agent 编剧室驱动你的长篇小说，保持设定一致与叙事张力。</p>
          </div>
          <button className="btn btn-primary" onClick={() => setShowModal(true)}>
            新建项目
          </button>
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
          <span className="chip">显示 {filteredProjects.length} / {projects.length}</span>
        </section>

        {/* 项目列表 */}
        <section className="project-list-grid">
          {loading && projects.length === 0 ? (
            <Skeleton variant="card" count={3} />
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
                className="card project-card"
                style={{ padding: 18, cursor: 'pointer' }}
                onClick={() => navigate(`/project/${project.id}`)}
                role="link"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') navigate(`/project/${project.id}`)
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                  <div>
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
