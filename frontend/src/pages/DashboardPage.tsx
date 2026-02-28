import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
    BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid,
    Tooltip, ResponsiveContainer, Legend,
} from 'recharts'
import { api } from '../lib/api'
import { useToastStore } from '../stores/useToastStore'
import PageTransition from '../components/ui/PageTransition'
import Skeleton from '../components/ui/Skeleton'

/** Unified chart theme aligned with the 2026-02 bright design system */
export const CHART_THEME = {
    accentColor: '#0a8b83',                    // var(--accent)
    gridColor: 'rgba(102, 124, 164, 0.16)',    // based on --glass-border
    tickColor: '#7e8fab',                       // var(--text-tertiary)
    legendColor: '#5a6e8d',                     // var(--text-secondary)
    tooltipBg: 'rgba(255, 255, 255, 0.96)',
    tooltipBorder: 'rgba(102, 124, 164, 0.22)',
    tooltipColor: '#1e2a3f',                    // var(--text-primary)
} as const

interface Metrics {
    chapter_generation_time: number
    search_time: number
    conflicts_per_chapter: number
    p0_ratio: number
    first_pass_rate: number
    exemption_rate: number
    recall_hit_rate: number
    sample_size?: number
    chapters_with_p0?: number
    chapters_first_pass_ok?: number
    chapters_with_memory_hits?: number
    quality_details?: {
        p0_conflict_chapters?: QualityDetailItem[]
        first_pass_failed_chapters?: QualityDetailItem[]
        recall_missed_chapters?: QualityDetailItem[]
    }
}

interface ProjectItem {
    id: string
    name: string
    genre: string
    style: string
    status: string
    chapter_count: number
    entity_count: number
    event_count: number
}

interface QualityDetailItem {
    project_id: string
    project_name: string
    chapter_id: string
    chapter_number: number
    chapter_title: string
    chapter_status: string
    p0_count: number
    first_pass_ok: boolean
    memory_hit_count: number
    has_unresolved_p0: boolean
}

type QualityDrillKey = 'p0_ratio' | 'first_pass_rate' | 'recall_hit_rate'

const QUALITY_DRILL_CONFIG: Record<
    QualityDrillKey,
    { label: string; accessor: (metrics: Metrics | null) => QualityDetailItem[] }
> = {
    p0_ratio: {
        label: 'P0 冲突章节',
        accessor: (metrics) => metrics?.quality_details?.p0_conflict_chapters ?? [],
    },
    first_pass_rate: {
        label: '一次通过失败章节',
        accessor: (metrics) => metrics?.quality_details?.first_pass_failed_chapters ?? [],
    },
    recall_hit_rate: {
        label: '记忆召回未命中章节',
        accessor: (metrics) => metrics?.quality_details?.recall_missed_chapters ?? [],
    },
}

/** Metric card definitions for the top row */
export const METRIC_CARDS = [
    { key: 'chapter_generation_time', label: '平均生成时间', unit: 's', format: (v: number) => v.toFixed(2) + 's' },
    { key: 'p0_ratio', label: 'P0 冲突率', unit: '%', format: (v: number) => (v * 100).toFixed(1) + '%' },
    { key: 'first_pass_rate', label: '一次通过率', unit: '%', format: (v: number) => (v * 100).toFixed(1) + '%' },
    { key: 'recall_hit_rate', label: '记忆召回命中率', unit: '%', format: (v: number) => (v * 100).toFixed(1) + '%' },
] as const

/** Build chart data from metrics */
export function buildBarChartData(metrics: Metrics) {
    return [
        { name: '章节生成时间', value: metrics.chapter_generation_time },
        { name: '检索时延', value: metrics.search_time },
        { name: '每章冲突数', value: metrics.conflicts_per_chapter },
    ]
}

export function buildLineChartData(metrics: Metrics) {
    return [
        { name: 'P0 冲突率', value: +(metrics.p0_ratio * 100).toFixed(1) },
        { name: '一次通过率', value: +(metrics.first_pass_rate * 100).toFixed(1) },
        { name: '豁免率', value: +(metrics.exemption_rate * 100).toFixed(1) },
        { name: '召回命中率', value: +(metrics.recall_hit_rate * 100).toFixed(1) },
    ]
}

/** Compute project summary totals */
export function computeTotals(projects: ProjectItem[]) {
    return {
        projectCount: projects.length,
        chapterCount: projects.reduce((sum, p) => sum + p.chapter_count, 0),
        entityCount: projects.reduce((sum, p) => sum + p.entity_count, 0),
        eventCount: projects.reduce((sum, p) => sum + p.event_count, 0),
    }
}

export default function DashboardPage() {
    const [metrics, setMetrics] = useState<Metrics | null>(null)
    const [projects, setProjects] = useState<ProjectItem[]>([])
    const [loading, setLoading] = useState(true)
    const [selectedDrillKey, setSelectedDrillKey] = useState<QualityDrillKey>('p0_ratio')
    const addToast = useToastStore((s) => s.addToast)

    const totals = useMemo(() => computeTotals(projects), [projects])
    const selectedQualityRows = useMemo(
        () => QUALITY_DRILL_CONFIG[selectedDrillKey].accessor(metrics),
        [metrics, selectedDrillKey],
    )

    const loadData = useCallback(async () => {
        setLoading(true)
        try {
            const [metricRes, projectRes] = await Promise.all([
                api.get('/metrics'),
                api.get('/projects'),
            ])
            setMetrics(metricRes.data)
            setProjects(projectRes.data ?? [])
        } catch {
            addToast('error', '获取看板数据失败')
        } finally {
            setLoading(false)
        }
    }, [addToast])

    useEffect(() => {
        void loadData()
    }, [loadData])

    if (loading) {
        return (
            <PageTransition>
                <div className="dashboard-page" data-testid="dashboard-skeleton">
                    <div className="page-head">
                        <div>
                            <h1 className="title">评测看板</h1>
                            <p className="subtitle">监控生成效率、冲突强度与回忆召回质量。</p>
                        </div>
                    </div>
                    <section className="grid-4">
                        <Skeleton variant="metric-card" count={4} />
                    </section>
                    <div className="chart-grid">
                        <Skeleton variant="card" />
                        <Skeleton variant="card" />
                    </div>
                    <div style={{ marginTop: 16 }}>
                        <Skeleton variant="table-row" count={3} />
                    </div>
                </div>
            </PageTransition>
        )
    }

    const barData = metrics ? buildBarChartData(metrics) : []
    const lineData = metrics ? buildLineChartData(metrics) : []

    return (
        <PageTransition>
            <div className="dashboard-page">
                <div className="page-head">
                    <div>
                        <h1 className="title">评测看板</h1>
                        <p className="subtitle">监控生成效率、冲突强度与回忆召回质量。</p>
                    </div>
                </div>

                {/* Metric cards */}
                <section className="grid-4" data-testid="metric-cards">
                    {METRIC_CARDS.map((card) => (
                        <div className="card metric-card" key={card.key}>
                            <div className="metric-label">{card.label}</div>
                            <div className="metric-value">
                                {metrics ? card.format(metrics[card.key as keyof Metrics] as number) : '--'}
                            </div>
                        </div>
                    ))}
                </section>
                <p className="muted" style={{ marginTop: 10 }}>
                    P0 冲突率 = 含未解决 P0 的章节占比；一次通过率 = 首轮可提交章节占比；记忆召回命中率 = 章节存在至少 1 条记忆命中占比。
                    当前样本章节：{metrics?.sample_size ?? 0}。
                </p>

                <section className="card dashboard-section" data-testid="quality-drilldown">
                    <h2 className="section-title">质量指标下钻</h2>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
                        {(Object.keys(QUALITY_DRILL_CONFIG) as QualityDrillKey[]).map((key) => (
                            <button
                                key={key}
                                className={`chip-btn ${selectedDrillKey === key ? 'active' : ''}`}
                                onClick={() => setSelectedDrillKey(key)}
                            >
                                {QUALITY_DRILL_CONFIG[key].label}
                            </button>
                        ))}
                    </div>
                    <p className="muted" style={{ marginTop: 10, marginBottom: 12 }}>
                        当前列表：{QUALITY_DRILL_CONFIG[selectedDrillKey].label}（{selectedQualityRows.length} 章）
                    </p>
                    <div className="table-wrap">
                        <table aria-label="质量下钻表格">
                            <thead>
                                <tr>
                                    <th>项目</th>
                                    <th>章节</th>
                                    <th>P0</th>
                                    <th>记忆命中</th>
                                    <th>状态</th>
                                    <th>操作</th>
                                </tr>
                            </thead>
                            <tbody>
                                {selectedQualityRows.length === 0 && (
                                    <tr>
                                        <td colSpan={6} className="muted">
                                            当前指标下没有异常章节。
                                        </td>
                                    </tr>
                                )}
                                {selectedQualityRows.map((item) => (
                                    <tr key={`${item.project_id}:${item.chapter_id}`}>
                                        <td>{item.project_name}</td>
                                        <td>
                                            第 {item.chapter_number} 章 · {item.chapter_title}
                                        </td>
                                        <td>{item.p0_count}</td>
                                        <td>{item.memory_hit_count}</td>
                                        <td>{item.chapter_status}</td>
                                        <td>
                                            <Link
                                                to={`/project/${item.project_id}/chapter/${item.chapter_id}`}
                                                className="btn btn-secondary"
                                                style={{ padding: '4px 10px', fontSize: '0.78rem', textDecoration: 'none' }}
                                            >
                                                查看
                                            </Link>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </section>

                {/* Charts */}
                <div className="chart-grid">
                    <section className="card dashboard-section" style={{ marginTop: 0 }}>
                        <h2 className="section-title">
                            性能指标
                        </h2>
                        <div data-testid="bar-chart" className="chart-container">
                            <ResponsiveContainer width="100%" height="100%">
                                <BarChart data={barData}>
                                    <CartesianGrid strokeDasharray="3 3" stroke={CHART_THEME.gridColor} />
                                    <XAxis dataKey="name" tick={{ fill: CHART_THEME.tickColor, fontSize: 12 }} />
                                    <YAxis tick={{ fill: CHART_THEME.tickColor, fontSize: 12 }} />
                                    <Tooltip
                                        contentStyle={{
                                            background: CHART_THEME.tooltipBg,
                                            border: `1px solid ${CHART_THEME.tooltipBorder}`,
                                            borderRadius: 12,
                                            color: CHART_THEME.tooltipColor,
                                            backdropFilter: 'blur(20px)',
                                        }}
                                    />
                                    <Legend wrapperStyle={{ color: CHART_THEME.legendColor, fontSize: 12 }} />
                                    <Bar dataKey="value" name="数值" fill={CHART_THEME.accentColor} radius={[6, 6, 0, 0]} />
                                </BarChart>
                            </ResponsiveContainer>
                        </div>
                    </section>

                    <section className="card dashboard-section" style={{ marginTop: 0 }}>
                        <h2 className="section-title">
                            质量指标
                        </h2>
                        <div data-testid="line-chart" className="chart-container">
                            <ResponsiveContainer width="100%" height="100%">
                                <LineChart data={lineData}>
                                    <CartesianGrid strokeDasharray="3 3" stroke={CHART_THEME.gridColor} />
                                    <XAxis dataKey="name" tick={{ fill: CHART_THEME.tickColor, fontSize: 12 }} />
                                    <YAxis tick={{ fill: CHART_THEME.tickColor, fontSize: 12 }} unit="%" />
                                    <Tooltip
                                        contentStyle={{
                                            background: CHART_THEME.tooltipBg,
                                            border: `1px solid ${CHART_THEME.tooltipBorder}`,
                                            borderRadius: 12,
                                            color: CHART_THEME.tooltipColor,
                                            backdropFilter: 'blur(20px)',
                                        }}
                                    />
                                    <Legend wrapperStyle={{ color: CHART_THEME.legendColor, fontSize: 12 }} />
                                    <Line type="monotone" dataKey="value" name="百分比" stroke={CHART_THEME.accentColor} strokeWidth={2} dot={{ fill: CHART_THEME.accentColor }} />
                                </LineChart>
                            </ResponsiveContainer>
                        </div>
                    </section>
                </div>

                {/* Summary stats */}
                <section className="card dashboard-section">
                    <h2 className="section-title">
                        项目统计汇总
                    </h2>
                    <div className="grid-4" data-testid="summary-stats">
                        <div className="card-strong summary-stat-item">
                            <span className="muted">项目数</span>
                            <strong>{totals.projectCount}</strong>
                        </div>
                        <div className="card-strong summary-stat-item">
                            <span className="muted">章节总数</span>
                            <strong>{totals.chapterCount}</strong>
                        </div>
                        <div className="card-strong summary-stat-item">
                            <span className="muted">实体总数</span>
                            <strong>{totals.entityCount}</strong>
                        </div>
                        <div className="card-strong summary-stat-item">
                            <span className="muted">事件总数</span>
                            <strong>{totals.eventCount}</strong>
                        </div>
                    </div>
                </section>

                {/* Project snapshot table */}
                <section className="card dashboard-section">
                    <h2 className="section-title">
                        项目快照
                    </h2>
                    <div className="table-wrap">
                        <table aria-label="项目快照表格">
                            <thead>
                                <tr>
                                    <th>项目</th>
                                    <th>章节</th>
                                    <th>实体</th>
                                    <th>事件</th>
                                </tr>
                            </thead>
                            <tbody>
                                {projects.length === 0 && (
                                    <tr>
                                        <td colSpan={4} className="muted">暂无项目数据。</td>
                                    </tr>
                                )}
                                {projects.map((project) => (
                                    <tr key={project.id}>
                                        <td>{project.name}</td>
                                        <td>{project.chapter_count}</td>
                                        <td>{project.entity_count}</td>
                                        <td>{project.event_count}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </section>
            </div>
        </PageTransition>
    )
}
