import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import ChapterWorkbenchPage from '../ChapterWorkbenchPage'

/* ── localStorage mock ── */
const localStorageMock = (() => {
    let store: Record<string, string> = {}
    return {
        getItem: vi.fn((key: string) => store[key] ?? null),
        setItem: vi.fn((key: string, value: string) => { store[key] = value }),
        removeItem: vi.fn((key: string) => { delete store[key] }),
        clear: vi.fn(() => { store = {} }),
    }
})()
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true })

/* ── Mocks ── */

vi.mock('framer-motion', () => ({
    motion: {
        div: ({ children, ...props }: any) => <div {...filterMotionProps(props)}>{children}</div>,
    },
    AnimatePresence: ({ children }: any) => <>{children}</>,
}))

function filterMotionProps(props: Record<string, any>) {
    const filtered: Record<string, any> = {}
    for (const key of Object.keys(props)) {
        if (!['initial', 'animate', 'exit', 'transition', 'whileHover', 'whileTap', 'layout'].includes(key)) {
            filtered[key] = props[key]
        }
    }
    return filtered
}

const sampleChapter = {
    id: 'ch-1',
    chapter_number: 1,
    title: '雪夜惊变',
    goal: '主角在雪夜遭遇背叛',
    plan: {
        beats: ['开场', '冲突', '高潮'],
        conflicts: ['背叛'],
        foreshadowing: ['暗号'],
        callback_targets: ['复仇'],
        role_goals: {},
    },
    plan_quality: null,
    draft: '这是草稿内容，主角走在雪地里。',
    final: null,
    status: 'draft',
    word_count: 18,
    conflicts: [
        { id: 'cf-1', severity: 'P0' as const, rule_id: 'R001', reason: '时间线矛盾' },
        { id: 'cf-2', severity: 'P1' as const, rule_id: 'R002', reason: '角色名不一致', suggested_fix: '统一为"李明"' },
    ],
}

const sampleChapterResolvedP0 = {
    ...sampleChapter,
    conflicts: [
        { id: 'cf-1', severity: 'P0' as const, rule_id: 'R001', reason: '时间线矛盾', resolved: true },
        { id: 'cf-2', severity: 'P1' as const, rule_id: 'R002', reason: '角色名不一致', suggested_fix: '统一为"李明"' },
    ],
}

const reviewingChapter = {
    ...sampleChapter,
    status: 'reviewing',
    conflicts: [{ id: 'cf-r1', severity: 'P1' as const, rule_id: 'R004', reason: '细节需确认' }],
}

const revisedChapter = {
    ...sampleChapter,
    status: 'revised',
    conflicts: [],
}

const approvedChapter = {
    ...sampleChapter,
    status: 'approved',
    conflicts: [],
}

const approvedChapterWithEmptyDraft = {
    ...approvedChapter,
    draft: '',
    final: '',
}

const mockApiGet = vi.fn()
const mockApiPost = vi.fn()
const mockApiPut = vi.fn()
const mockApiDelete = vi.fn()

vi.mock('../../lib/api', () => ({
    LLM_TIMEOUT: 120_000,
    api: {
        get: (...args: any[]) => mockApiGet(...args),
        post: (...args: any[]) => mockApiPost(...args),
        put: (...args: any[]) => mockApiPut(...args),
        delete: (...args: any[]) => mockApiDelete(...args),
    },
}))

const mockAddToast = vi.fn()
vi.mock('../../stores/useToastStore', () => ({
    useToastStore: (selector: (s: any) => any) => selector({ addToast: mockAddToast }),
}))

let mockReadingMode = false
const mockEnterReadingMode = vi.fn(() => { mockReadingMode = true })
const mockExitReadingMode = vi.fn(() => { mockReadingMode = false })

vi.mock('../../stores/useUIStore', () => ({
    useUIStore: (selector: (s: any) => any) =>
        selector({
            readingMode: mockReadingMode,
            enterReadingMode: mockEnterReadingMode,
            exitReadingMode: mockExitReadingMode,
        }),
}))

const mockFetchChapters = vi.fn()
const mockFetchProject = vi.fn()
const mockInvalidateCache = vi.fn()
const mockAddAccess = vi.fn()
const mockStoreChapters = [
    { id: 'ch-1', chapter_number: 1, title: '雪夜惊变', goal: '', status: 'draft', word_count: 18, conflict_count: 1 },
    { id: 'ch-2', chapter_number: 2, title: '潜伏反击', goal: '', status: 'draft', word_count: 1200, conflict_count: 0 },
]

vi.mock('../../stores/useProjectStore', () => ({
    useProjectStore: (selector: (s: any) => any) =>
        selector({
            currentProject: { id: 'proj-1', name: '霜城编年史' },
            chapters: mockStoreChapters,
            fetchChapters: mockFetchChapters,
            fetchProject: mockFetchProject,
            invalidateCache: mockInvalidateCache,
        }),
}))

vi.mock('../../stores/useRecentAccessStore', () => ({
    useRecentAccessStore: (selector: (s: any) => any) =>
        selector({
            addAccess: mockAddAccess,
        }),
}))

// Mock ChapterExportMenu to simplify testing
vi.mock('../../components/chapter/ChapterExportMenu', () => ({
    default: ({ projectName }: any) => <div data-testid="export-menu">导出菜单-{projectName}</div>,
}))

// Mock ReadingModeToolbar
vi.mock('../../components/ui/ReadingModeToolbar', () => ({
    default: ({ onExit, currentLabel }: any) => (
        <div data-testid="reading-toolbar">
            <button type="button" onClick={onExit}>退出阅读</button>
            <span>{currentLabel}</span>
        </div>
    ),
}))

/* ── Helpers ── */

function renderPage(chapterId = 'ch-1', projectId = 'proj-1') {
    return render(
        <MemoryRouter initialEntries={[`/project/${projectId}/chapter/${chapterId}`]}>
            <Routes>
                <Route path="/project/:projectId/chapter/:chapterId" element={<ChapterWorkbenchPage />} />
                <Route path="/project/:projectId" element={<div>项目详情页</div>} />
                <Route path="/project/:projectId/trace/:chapterId" element={<div>决策回放页</div>} />
            </Routes>
        </MemoryRouter>,
    )
}

/* ── Tests ── */

describe('ChapterWorkbenchPage', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mockReadingMode = false
        mockApiGet.mockResolvedValue({ data: sampleChapter })
        mockApiPost.mockResolvedValue({ data: {} })
        mockApiPut.mockResolvedValue({ data: { chapter: sampleChapter } })
        mockApiDelete.mockResolvedValue({ data: { status: 'deleted' } })
    })

    /* ── 骨架屏加载状态 ── */

    it('加载时显示骨架屏', () => {
        // 让 API 永远 pending
        mockApiGet.mockReturnValue(new Promise(() => { }))
        renderPage()
        const skeletons = document.querySelectorAll('.skeleton')
        expect(skeletons.length).toBeGreaterThan(0)
    })

    /* ── 正常渲染 ── */

    it('加载完成后显示章节标题和目标', async () => {
        renderPage()
        await waitFor(() => {
            expect(screen.getByText(/第 1 章 · 雪夜惊变/)).toBeTruthy()
        })
        expect(screen.getAllByText('主角在雪夜遭遇背叛').length).toBeGreaterThan(0)
    })

    it('显示返回项目链接', async () => {
        renderPage()
        await waitFor(() => {
            expect(screen.getByText('← 返回项目')).toBeTruthy()
        })
    })

    it('显示删除本章按钮并可打开确认框', async () => {
        renderPage()
        await waitFor(() => {
            expect(screen.getByText('删除本章')).toBeTruthy()
        })
        fireEvent.click(screen.getByText('删除本章'))
        expect(screen.getByText('确认删除当前章节？')).toBeTruthy()
    })

    it('不再显示一句话整篇入口', async () => {
        renderPage()
        await waitFor(() => {
            expect(screen.getByText(/第 1 章 · 雪夜惊变/)).toBeTruthy()
        })
        expect(screen.queryByText('一句话整篇')).toBeNull()
        expect(screen.queryByText('一句话生成整篇')).toBeNull()
    })

    it('显示决策回放链接', async () => {
        renderPage()
        await waitFor(() => {
            expect(screen.getByText('决策回放')).toBeTruthy()
        })
    })

    it('显示一键发布章节按钮并可触发发布接口', async () => {
        mockApiPost.mockResolvedValueOnce({ data: { success: true, chapter_number: 1, book_id: 'b-1' } })
        renderPage()
        await waitFor(() => {
            expect(screen.getByText('一键发布章节')).toBeTruthy()
        })

        fireEvent.click(screen.getByText('一键发布章节'))

        await waitFor(() => {
            expect(mockApiPost).toHaveBeenCalledWith(
                '/chapters/ch-1/publish',
                expect.objectContaining({
                    title: expect.stringContaining('第1章'),
                    content: expect.any(String),
                }),
                expect.objectContaining({ timeout: 300000 }),
            )
        })
    })

    it('显示创建并绑定番茄书本按钮并可触发接口', async () => {
        mockApiPost.mockResolvedValueOnce({ data: { success: true, book_id: '7600000000000000000' } })
        renderPage()
        await waitFor(() => {
            expect(screen.getByText('创建并绑定番茄书本')).toBeTruthy()
        })

        fireEvent.click(screen.getByText('填写番茄参数'))
        const introInput = screen.getByPlaceholderText('可留空（后端会按项目信息补全）')
        fireEvent.change(introInput, { target: { value: '测试简介补充文本' } })

        fireEvent.click(screen.getByText('创建并绑定番茄书本'))

        await waitFor(() => {
            expect(mockApiPost).toHaveBeenCalledWith(
                '/projects/proj-1/fanqie/create-book',
                expect.objectContaining({
                    title: '霜城编年史',
                    target_reader: 'male',
                    intro: '测试简介补充文本',
                    tags_by_tab: {
                        主分类: ['悬疑脑洞'],
                        主题: ['赛博朋克'],
                        角色: ['神探'],
                        情节: ['惊悚游戏'],
                    },
                }),
                expect.objectContaining({ timeout: 300000 }),
            )
        })
    })

    it('支持LLM填充番茄创建参数', async () => {
        mockApiPost
            .mockResolvedValueOnce({
                data: {
                    success: true,
                    title_reference: '霜城编年史',
                    intro: '这是LLM生成的简介，超过五十字，满足平台简介字段长度要求。',
                    protagonist1: '沈砺',
                    protagonist2: '苏岚',
                    target_reader: 'female',
                    tags_by_tab: {
                        主分类: ['悬疑脑洞'],
                        主题: ['赛博朋克'],
                        角色: ['神探'],
                        情节: ['惊悚游戏'],
                    },
                },
            })
        renderPage()
        await waitFor(() => {
            expect(screen.getByText('填写番茄参数')).toBeTruthy()
        })

        fireEvent.click(screen.getByText('填写番茄参数'))
        fireEvent.click(screen.getByText('LLM 填充剩余字段'))

        await waitFor(() => {
            expect(mockApiPost).toHaveBeenCalledWith(
                '/projects/proj-1/fanqie/create-book/suggest',
                expect.objectContaining({ prompt: expect.any(String) }),
                expect.objectContaining({ timeout: 120000 }),
            )
        })
        await waitFor(() => {
            expect(screen.getByDisplayValue('沈砺')).toBeTruthy()
            expect(screen.getByDisplayValue('苏岚')).toBeTruthy()
            expect(screen.getByDisplayValue('悬疑脑洞')).toBeTruthy()
        })
    })

    /* ── 导出菜单集成 ── */

    it('渲染导出菜单组件', async () => {
        renderPage()
        await waitFor(() => {
            expect(screen.getByTestId('export-menu')).toBeTruthy()
        })
        expect(screen.getByText('导出菜单-霜城编年史')).toBeTruthy()
    })

    /* ── 阅读模式集成 ── */

    it('显示阅读模式按钮', async () => {
        renderPage()
        await waitFor(() => {
            expect(screen.getByText('阅读模式')).toBeTruthy()
        })
    })

    it('点击阅读模式按钮调用 enterReadingMode', async () => {
        renderPage()
        await waitFor(() => {
            expect(screen.getByText('阅读模式')).toBeTruthy()
        })
        fireEvent.click(screen.getByText('阅读模式'))
        expect(mockEnterReadingMode).toHaveBeenCalledTimes(1)
    })

    it('阅读模式下显示浮动工具条', async () => {
        mockReadingMode = true
        renderPage()
        await waitFor(() => {
            expect(screen.getByTestId('reading-toolbar')).toBeTruthy()
        })
        expect(screen.getByText(/第 1 章 · 雪夜惊变/)).toBeTruthy()
    })

    it('阅读模式下隐藏编辑控件', async () => {
        mockReadingMode = true
        renderPage()
        await waitFor(() => {
            expect(screen.getByTestId('reading-toolbar')).toBeTruthy()
        })
        expect(screen.queryByText('章节蓝图')).toBeNull()
        expect(screen.queryByText('一致性冲突')).toBeNull()
        expect(screen.queryByText('重做本章')).toBeNull()
    })

    it('阅读模式下点击退出调用 exitReadingMode', async () => {
        mockReadingMode = true
        renderPage()
        await waitFor(() => {
            expect(screen.getByText('退出阅读')).toBeTruthy()
        })
        fireEvent.click(screen.getByText('退出阅读'))
        expect(mockExitReadingMode).toHaveBeenCalledTimes(1)
    })

    it('阅读模式保留正文方括号内容，仅清理思考标签噪音', async () => {
        mockReadingMode = true
        mockApiGet.mockResolvedValue({
            data: {
                ...sampleChapter,
                draft: [
                    '普通段落。',
                    '[……滋滋……节点……共鸣……增强……]',
                    '[thinking: 这是思考噪音]',
                    '【reasoning：内部推理】',
                    '[……第七区……欢迎……来到……]',
                ].join('\n\n'),
            },
        })
        renderPage()
        await waitFor(() => {
            expect(screen.getByTestId('reading-toolbar')).toBeTruthy()
        })
        expect(screen.getByText('[……滋滋……节点……共鸣……增强……]')).toBeTruthy()
        expect(screen.getByText('[……第七区……欢迎……来到……]')).toBeTruthy()
        expect(screen.queryByText('[thinking: 这是思考噪音]')).toBeNull()
        expect(screen.queryByText('【reasoning：内部推理】')).toBeNull()
    })

    /* ── 蓝图面板 ── */

    it('显示蓝图节拍列表', async () => {
        renderPage()
        await waitFor(() => {
            expect(screen.getByText('章节蓝图')).toBeTruthy()
        })
        expect(screen.getByText('开场')).toBeTruthy()
        expect(screen.getAllByText('冲突').length).toBeGreaterThan(0)
        expect(screen.getByText('高潮')).toBeTruthy()
    })

    it('无蓝图时显示提示', async () => {
        mockApiGet.mockResolvedValue({ data: { ...sampleChapter, plan: undefined } })
        renderPage()
        await waitFor(() => {
            expect(screen.getByText('尚未生成蓝图。')).toBeTruthy()
        })
    })

    it('蓝图质量告警会显示在蓝图面板顶部', async () => {
        mockApiGet.mockResolvedValue({
            data: {
                ...sampleChapter,
                plan_quality: {
                    status: 'warn',
                    score: 58,
                    issues: ['检测到模板化蓝图语句，建议重试生成。'],
                    warnings: ['缺少角色目标，后续可在章节工作台补充。'],
                    retried: true,
                    attempts: 2,
                },
            },
        })
        renderPage()
        await waitFor(() => {
            expect(screen.getByText('蓝图质量告警')).toBeTruthy()
            expect(screen.getByText('评分 58')).toBeTruthy()
            expect(screen.getByText('检测到模板化蓝图语句，建议重试生成。')).toBeTruthy()
        })
    })

    it('蓝图键值流会合并为单条而不是拆散成噪声卡片', async () => {
        mockApiGet.mockResolvedValue({
            data: {
                ...sampleChapter,
                plan: {
                    ...sampleChapter.plan,
                    conflicts: [
                        'type',
                        '外部武力冲突',
                        'description',
                        '拆迁楼内，苏小柒被黑衣人追杀，陆仁甲被迫卷入战斗。',
                        'type',
                        '人物关系冲突',
                        'description',
                        '猪肉铺内，陆仁甲与苏小柒因信息不对等互相质疑。',
                    ],
                    foreshadowing: [
                        'item',
                        '导师的医疗事故',
                        'description',
                        '通过视频闪回和记忆被明确提出，暗示并非简单事故。',
                    ],
                    callback_targets: [
                        'target',
                        '酱油画的笑脸和留言',
                        'potential_use',
                        '成为苏小柒与陆仁甲之间的联络符号。',
                    ],
                },
            },
        })
        renderPage()
        await waitFor(() => {
            expect(screen.getByText('外部武力冲突')).toBeTruthy()
            expect(screen.getByText('拆迁楼内，苏小柒被黑衣人追杀，陆仁甲被迫卷入战斗。')).toBeTruthy()
            expect(screen.getByText('导师的医疗事故')).toBeTruthy()
            expect(screen.getByText('酱油画的笑脸和留言')).toBeTruthy()
        })
        expect(screen.queryByText(/^type$/i)).toBeNull()
        expect(screen.queryByText(/^description$/i)).toBeNull()
        expect(screen.queryByText(/^item$/i)).toBeNull()
        expect(screen.queryByText(/^target$/i)).toBeNull()
    })

    /* ── 冲突面板 ── */

    it('显示冲突统计', async () => {
        renderPage()
        await waitFor(() => {
            expect(screen.getByText('P0 1')).toBeTruthy()
        })
        expect(screen.getByText('P1 1')).toBeTruthy()
    })

    it('一致性冲突卡片位于正文草稿卡片之后', async () => {
        renderPage()
        await waitFor(() => {
            expect(screen.getByText('正文草稿')).toBeTruthy()
            expect(screen.getByText('一致性冲突')).toBeTruthy()
        })

        const draftHeading = screen.getByText('正文草稿')
        const conflictsHeading = screen.getByText('一致性冲突')
        const rightColumn = document.querySelector('.workbench-right-column')
        const draftCard = draftHeading.closest('section.card')
        const conflictsCard = conflictsHeading.closest('section.card')

        expect(rightColumn).toBeTruthy()
        expect(draftCard).toBeTruthy()
        expect(conflictsCard).toBeTruthy()
        expect(conflictsCard).not.toBe(draftCard)
        expect(rightColumn?.contains(draftCard as Node)).toBe(true)
        expect(rightColumn?.contains(conflictsCard as Node)).toBe(true)
        expect(
            draftHeading.compareDocumentPosition(conflictsHeading) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy()
    })

    it('显示冲突详情和建议修复', async () => {
        renderPage()
        await waitFor(() => {
            expect(screen.getByText('时间线矛盾')).toBeTruthy()
        })
        expect(screen.getByText('建议：统一为"李明"')).toBeTruthy()
    })

    /* ── 草稿区域 ── */

    it('显示草稿内容', async () => {
        renderPage()
        await waitFor(() => {
            expect(screen.getByText('这是草稿内容，主角走在雪地里。')).toBeTruthy()
        })
    })

    it('加载后会从 trace 回填流式侧通道', async () => {
        mockApiGet.mockImplementation((url: string) => {
            if (url === '/chapters/ch-1') {
                return Promise.resolve({ data: sampleChapter })
            }
            if (url === '/trace/ch-1') {
                return Promise.resolve({
                    data: {
                        channel_snapshot: {
                            director: '导演阶段内容',
                            setter: '设定阶段内容',
                            stylist: '润色阶段内容',
                        },
                    },
                })
            }
            return Promise.resolve({ data: sampleChapter })
        })

        renderPage()
        await waitFor(() => {
            expect(mockApiGet).toHaveBeenCalledWith('/trace/ch-1')
        })

        fireEvent.click(screen.getByText('导演'))
        expect(await screen.findByText('导演阶段内容')).toBeTruthy()

        fireEvent.click(screen.getByText('设定'))
        expect(await screen.findByText('设定阶段内容')).toBeTruthy()

        fireEvent.click(screen.getByText('润色'))
        expect(await screen.findByText('润色阶段内容')).toBeTruthy()
    })

    it('显示字数统计', async () => {
        renderPage()
        await waitFor(() => {
            expect(screen.getByText('字数 18')).toBeTruthy()
        })
    })

    it('有 P0 冲突时禁用提交审批按钮', async () => {
        renderPage()
        await waitFor(() => {
            expect(screen.getByRole('button', { name: '提交审批' })).toBeTruthy()
        })
        expect(screen.getByRole('button', { name: '提交审批' })).toHaveProperty('disabled', true)
    })

    it('全部 P0 已 resolved 时允许提交审批按钮可点击', async () => {
        mockApiGet.mockResolvedValue({ data: sampleChapterResolvedP0 })
        renderPage()
        await waitFor(() => {
            expect(screen.getByRole('button', { name: '提交审批' })).toBeTruthy()
        })
        expect(screen.getByRole('button', { name: '提交审批' })).toHaveProperty('disabled', false)
    })

    it('审批遇到 P0 策略错误时显示精确提示', async () => {
        mockApiGet.mockResolvedValue({ data: sampleChapterResolvedP0 })
        mockApiPost.mockRejectedValue({ response: { data: { detail: 'P0 conflicts must be resolved before approval' } } })
        renderPage()
        await waitFor(() => {
            expect(screen.getByRole('button', { name: '提交审批' })).toBeTruthy()
        })
        fireEvent.click(screen.getByRole('button', { name: '提交审批' }))
        await waitFor(() => {
            expect(mockAddToast).toHaveBeenCalledWith('error', '需先解决 P0 冲突后再审批', expect.objectContaining({
                context: '审批操作',
                detail: 'P0 conflicts must be resolved before approval',
            }))
        })
    })

    it('审批遇到普通错误时仍显示通用失败提示', async () => {
        mockApiGet.mockResolvedValue({ data: sampleChapterResolvedP0 })
        mockApiPost.mockRejectedValue(new Error('网络错误'))
        renderPage()
        await waitFor(() => {
            expect(screen.getByRole('button', { name: '提交审批' })).toBeTruthy()
        })
        fireEvent.click(screen.getByRole('button', { name: '提交审批' }))
        await waitFor(() => {
            expect(mockAddToast).toHaveBeenCalledWith('error', '提交审批失败', expect.objectContaining({
                context: '审批操作',
                detail: '网络错误',
            }))
        })
    })

    it('已审批状态展示状态与流程提示，按钮显示为重新打开审核并可点击', async () => {
        mockApiGet.mockResolvedValue({ data: approvedChapter })
        renderPage()
        await waitFor(() => {
            expect(screen.getByText('当前状态：已审批')).toBeTruthy()
            expect(screen.getByText('当前已审批：如需继续修改，请先重新打开审核。')).toBeTruthy()
            expect(screen.getByRole('button', { name: '重新打开审核' })).toBeTruthy()
        })
        expect(screen.getByRole('button', { name: '重新打开审核' })).toHaveProperty('disabled', false)
    })

    it('已审批状态点击重新打开审核会调用 rescan 并提示成功', async () => {
        mockApiGet.mockResolvedValue({ data: approvedChapter })
        mockApiPost.mockResolvedValueOnce({ data: { status: 'reviewing', action: 'rescan' } })
        renderPage()
        await waitFor(() => {
            expect(screen.getByRole('button', { name: '重新打开审核' })).toBeTruthy()
        })
        fireEvent.click(screen.getByRole('button', { name: '重新打开审核' }))
        await waitFor(() => {
            expect(mockApiPost).toHaveBeenCalledWith('/review', { chapter_id: 'ch-1', action: 'rescan' }, expect.any(Object))
            expect(mockAddToast).toHaveBeenCalledWith('success', '已重新打开审核，可继续修改后再提交审批')
        })
    })

    it('已审批且草稿为空时仍可重新打开审核', async () => {
        mockApiGet.mockResolvedValue({ data: approvedChapterWithEmptyDraft })
        renderPage()
        await waitFor(() => {
            expect(screen.getByRole('button', { name: '重新打开审核' })).toBeTruthy()
        })
        expect(screen.getByRole('button', { name: '重新打开审核' })).toHaveProperty('disabled', false)
    })

    it('待审核与已退回状态展示对应流程提示与统一主按钮', async () => {
        mockApiGet.mockResolvedValueOnce({ data: reviewingChapter })
        renderPage()
        await waitFor(() => {
            expect(screen.getByText('当前状态：待审核')).toBeTruthy()
            expect(screen.getByText('下一步：先处理冲突项，再提交审批。')).toBeTruthy()
            expect(screen.getByRole('button', { name: '提交审批' })).toBeTruthy()
        })

        mockApiGet.mockResolvedValueOnce({ data: revisedChapter })
        renderPage()
        await waitFor(() => {
            expect(screen.getByText('当前状态：已退回')).toBeTruthy()
            expect(screen.getByText('下一步：根据退回意见修改，完成后重新提交审批。')).toBeTruthy()
        })
    })

    /* ── Toast 通知 ── */

    it('加载失败时触发 error Toast', async () => {
        mockApiGet.mockRejectedValue(new Error('网络错误'))
        renderPage()
        await waitFor(() => {
            expect(mockAddToast).toHaveBeenCalledWith('error', '加载章节失败，请稍后重试')
        })
    })

    it('重新生成蓝图成功时触发 success Toast', async () => {
        mockApiPost.mockResolvedValue({ data: {} })
        renderPage()
        await waitFor(() => {
            expect(screen.getAllByText('重新生成蓝图').length).toBeGreaterThan(0)
        })
        fireEvent.click(screen.getAllByText('重新生成蓝图')[0])
        await waitFor(() => {
            expect(mockAddToast).toHaveBeenCalledWith('success', '蓝图生成成功')
        })
    })

    it('重新生成蓝图失败时触发 error Toast', async () => {
        mockApiPost.mockRejectedValue(new Error('后端错误'))
        renderPage()
        await waitFor(() => {
            expect(screen.getAllByText('重新生成蓝图').length).toBeGreaterThan(0)
        })
        fireEvent.click(screen.getAllByText('重新生成蓝图')[0])
        await waitFor(() => {
            expect(mockAddToast).toHaveBeenCalledWith('error', '蓝图生成失败', expect.objectContaining({
                context: '蓝图生成',
            }))
        })
    })

    it('蓝图生成存在质量风险时触发 warning Toast', async () => {
        mockApiPost.mockResolvedValue({
            data: {
                plan: sampleChapter.plan,
                quality: {
                    status: 'warn',
                    score: 61,
                    issues: ['节拍缺失，已自动补齐。'],
                    warnings: ['缺少角色目标，后续可在章节工作台补充。'],
                },
            },
        })
        renderPage()
        await waitFor(() => {
            expect(screen.getAllByText('重新生成蓝图').length).toBeGreaterThan(0)
        })
        fireEvent.click(screen.getAllByText('重新生成蓝图')[0])
        await waitFor(() => {
            expect(mockAddToast).toHaveBeenCalledWith('warning', '蓝图质量告警', expect.objectContaining({
                context: expect.stringContaining('质量分 61'),
            }))
        })
    })

    /* ── 编辑模式 ── */

    it('不再显示预览正文切换按钮', async () => {
        renderPage()
        await waitFor(() => {
            expect(screen.getByText('保存编辑并重检')).toBeTruthy()
        })
        expect(screen.queryByText('预览正文')).toBeNull()
        expect(screen.queryByText('返回编辑')).toBeNull()
    })

    it('不再提供清空创作台入口', async () => {
        mockApiGet.mockImplementation((url: string) => {
            if (url === '/chapters/ch-1') {
                return Promise.resolve({ data: sampleChapter })
            }
            if (url === '/trace/ch-1') {
                return Promise.resolve({
                    data: {
                        channel_snapshot: {
                            director: '导演阶段待办',
                            setter: '设定阶段校验',
                            stylist: '润色阶段建议',
                        },
                    },
                })
            }
            return Promise.resolve({ data: sampleChapter })
        })

        renderPage()
        await waitFor(() => {
            expect(screen.getByText('保存编辑并重检')).toBeTruthy()
        })
        expect(screen.queryByText('清空创作台')).toBeNull()
        expect(screen.queryByText('清空当前创作台？')).toBeNull()
    })

    it('重做本章完成后会清理本地草稿，避免弹出恢复对话框', async () => {
        const frames = [
            'event: chunk\ndata: {"chunk":"流式正文片段"}\n\n',
            'event: done\ndata: {"consistency":{"can_submit":true,"conflicts":[]},"chapter":{"id":"ch-1"}}\n\n',
        ]
        const encoder = new TextEncoder()
        let index = 0
        const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
                if (index < frames.length) {
                    controller.enqueue(encoder.encode(frames[index]))
                    index += 1
                    return
                }
                controller.close()
            },
        })
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
            ok: true,
            status: 200,
            body: stream,
            text: async () => '',
        } as unknown as Response)

        renderPage()
        await waitFor(() => {
            expect(screen.getByText('重做本章')).toBeTruthy()
        })

        localStorageMock.removeItem.mockClear()

        fireEvent.change(screen.getByPlaceholderText(/描述你想怎么改这一章/), {
            target: { value: '把背叛改成暗中保护的误会' },
        })
        fireEvent.click(screen.getByText('重做本章'))

        await waitFor(() => {
            expect(fetchSpy).toHaveBeenCalledTimes(1)
        })
        expect(fetchSpy.mock.calls[0]?.[0]).toBe('/api/chapters/ch-1/one-shot/stream')

        await waitFor(() => {
            expect(mockAddToast).toHaveBeenCalledWith('success', '本章重做完成')
        })

        expect(localStorageMock.removeItem).toHaveBeenCalledWith('draft-ch-1')
        expect(screen.queryByText('发现本地草稿')).toBeNull()
    })

    it('保存草稿成功时触发 success Toast', async () => {
        renderPage()
        await waitFor(() => {
            expect(screen.getByText('保存编辑并重检')).toBeTruthy()
        })
        fireEvent.click(screen.getByText('保存编辑并重检'))
        await waitFor(() => {
            expect(mockAddToast).toHaveBeenCalledWith('success', '草稿保存成功')
        })
    })

    /* ── useProjectStore 集成 ── */

    it('加载时调用 fetchChapters', async () => {
        renderPage()
        await waitFor(() => {
            expect(mockFetchChapters).toHaveBeenCalledWith('proj-1')
        })
    })

    it('保留修改方向输入并用于重新生成蓝图', async () => {
        renderPage()
        await waitFor(() => {
            expect(screen.getByPlaceholderText(/描述你想怎么改这一章/)).toBeTruthy()
        })

        expect(screen.getByText('章节修改方向')).toBeTruthy()

        fireEvent.change(screen.getByPlaceholderText(/描述你想怎么改这一章/), {
            target: { value: '把背叛改成暗中保护的误会' },
        })
        fireEvent.click(screen.getAllByText('重新生成蓝图')[0])

        await waitFor(() => {
            expect(mockApiPost).toHaveBeenCalledWith(
                '/chapters/ch-1/plan',
                { direction_hint: '把背叛改成暗中保护的误会' },
                expect.any(Object),
            )
        })
    })

    it('保留重做本章按钮并移除流式生成草稿入口', async () => {
        renderPage()
        await waitFor(() => {
            expect(screen.getByText('重做本章')).toBeTruthy()
        })

        expect(screen.queryByText('流式生成草稿')).toBeNull()
        expect(screen.queryByText('继续流式生成')).toBeNull()
    })

    it('导演设定润色通道使用固定高度只读文本框查看区', async () => {
        mockApiGet.mockImplementation((url: string) => {
            if (url === '/chapters/ch-1') {
                return Promise.resolve({ data: sampleChapter })
            }
            if (url === '/trace/ch-1') {
                return Promise.resolve({
                    data: {
                        channel_snapshot: {
                            director: '导演阶段待办',
                            setter: '设定阶段校验',
                            stylist: '润色阶段建议',
                        },
                    },
                })
            }
            return Promise.resolve({ data: sampleChapter })
        })

        renderPage()
        await waitFor(() => {
            expect(screen.getByText('导演')).toBeTruthy()
        })

        fireEvent.click(screen.getByText('导演'))
        await waitFor(() => {
            expect(Array.from(document.querySelectorAll('textarea')).some((node) =>
                (node as HTMLTextAreaElement).value.includes('导演阶段待办'),
            )).toBe(true)
        })

        const readonlyArea = Array.from(document.querySelectorAll('textarea')).find((node) =>
            (node as HTMLTextAreaElement).value.includes('导演阶段待办'),
        ) as HTMLTextAreaElement | undefined

        expect(readonlyArea).toBeTruthy()
        expect(readonlyArea?.readOnly).toBe(true)
        expect(readonlyArea?.style.minHeight).toBe('480px')
        expect(readonlyArea?.style.overflow).toBe('auto')
    })

    it('不再提供删除并重建同编号入口', async () => {
        renderPage()
        await waitFor(() => {
            expect(screen.getByText('删除本章')).toBeTruthy()
        })

        fireEvent.click(screen.getByText('删除本章'))

        await waitFor(() => {
            expect(screen.getByText('确认删除当前章节？')).toBeTruthy()
        })

        expect(screen.queryByText('删除并重建同编号')).toBeNull()
    })

    it('存在后续章节时显示重做本章衔接风险提示', async () => {
        mockStoreChapters.splice(
            0,
            mockStoreChapters.length,
            { id: 'ch-1', chapter_number: 1, title: '雪夜惊变', goal: '', status: 'draft', word_count: 18, conflict_count: 1 },
            { id: 'ch-2', chapter_number: 2, title: '第二章', goal: '后续章节', status: 'draft', word_count: 1200, conflict_count: 0 },
        )
        renderPage()

        await waitFor(() => {
            expect(screen.getByText('重做本章')).toBeTruthy()
        })

        expect(screen.getByText(/后续章节已存在，重做本章可能导致与后续章节的衔接出现不一致/)).toBeTruthy()
    })

    /* ── 自动保存集成 ── */

    describe('自动保存', () => {
        beforeEach(() => {
            vi.useFakeTimers()
            localStorageMock.clear()
        })

        afterEach(() => {
            vi.useRealTimers()
            localStorageMock.clear()
        })

        it('编辑模式下输入内容后显示已自动保存提示', async () => {
            vi.useRealTimers()
            renderPage()
            await waitFor(() => {
                expect(screen.getByText('保存编辑并重检')).toBeTruthy()
            })

            // Type into the textarea
            const textarea = screen.getAllByRole('textbox').find(
                (el) => (el as HTMLTextAreaElement).value === '这是草稿内容，主角走在雪地里。'
            ) as HTMLTextAreaElement
            fireEvent.change(textarea, { target: { value: '修改后的草稿内容' } })

            // Wait for debounce to fire (useAutoSave debounceMs=2000)
            await new Promise((r) => setTimeout(r, 2500))

            expect(screen.getByText('已自动保存')).toBeTruthy()
        })

        it('存在本地草稿时显示恢复对话框', async () => {
            // Pre-populate localStorage with a draft
            localStorageMock.setItem(
                'draft-ch-1',
                JSON.stringify({ content: '本地保存的草稿内容', timestamp: Date.now() })
            )

            vi.useRealTimers()
            renderPage()

            await waitFor(() => {
                expect(screen.getByText('发现本地草稿')).toBeTruthy()
            })
            expect(screen.getByText('恢复草稿')).toBeTruthy()
            expect(screen.getByText('丢弃草稿')).toBeTruthy()
        })

        it('本地草稿与服务端一致时不显示恢复对话框', async () => {
            localStorageMock.setItem(
                'draft-ch-1',
                JSON.stringify({ content: sampleChapter.draft, timestamp: Date.now() })
            )

            vi.useRealTimers()
            renderPage()

            await waitFor(() => {
                expect(screen.getByText(/第 1 章 · 雪夜惊变/)).toBeTruthy()
            })
            expect(screen.queryByText('发现本地草稿')).toBeNull()
            expect(localStorageMock.getItem('draft-ch-1')).toBeNull()
        })

        it('点击恢复草稿后恢复内容并进入编辑模式', async () => {
            localStorageMock.setItem(
                'draft-ch-1',
                JSON.stringify({ content: '本地保存的草稿内容', timestamp: Date.now() })
            )

            vi.useRealTimers()
            renderPage()

            await waitFor(() => {
                expect(screen.getByText('发现本地草稿')).toBeTruthy()
            })

            fireEvent.click(screen.getByText('恢复草稿'))

            // Dialog should close
            expect(screen.queryByText('发现本地草稿')).toBeNull()

            expect(screen.getByText('保存编辑并重检')).toBeTruthy()
            const textarea = screen.getAllByRole('textbox').find(
                (el) => (el as HTMLTextAreaElement).value === '本地保存的草稿内容'
            )
            expect(textarea).toBeTruthy()
        })

        it('点击丢弃草稿后关闭对话框并清除 localStorage', async () => {
            localStorageMock.setItem(
                'draft-ch-1',
                JSON.stringify({ content: '本地保存的草稿内容', timestamp: Date.now() })
            )

            vi.useRealTimers()
            renderPage()

            await waitFor(() => {
                expect(screen.getByText('发现本地草稿')).toBeTruthy()
            })

            fireEvent.click(screen.getByText('丢弃草稿'))

            // Dialog should close
            expect(screen.queryByText('发现本地草稿')).toBeNull()

            // localStorage should be cleared
            expect(localStorageMock.getItem('draft-ch-1')).toBeNull()
        })
    })
})
