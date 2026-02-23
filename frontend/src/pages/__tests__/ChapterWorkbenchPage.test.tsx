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

const mockApiGet = vi.fn()
const mockApiPost = vi.fn()
const mockApiPut = vi.fn()
const mockApiDelete = vi.fn()

vi.mock('../../lib/api', () => ({
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
            <button onClick={onExit}>退出阅读</button>
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
        expect(screen.getByText('删除当前章节？')).toBeTruthy()
    })

    it('一句话整篇字数输入允许清空后重输', async () => {
        renderPage()
        await waitFor(() => {
            expect(screen.getByText('一句话整篇')).toBeTruthy()
        })
        const wordInput = screen.getByDisplayValue('1600') as HTMLInputElement
        fireEvent.change(wordInput, { target: { value: '' } })
        expect(wordInput.value).toBe('')
        fireEvent.change(wordInput, { target: { value: '2200' } })
        expect(wordInput.value).toBe('2200')
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
        expect(screen.queryByText('流式生成草稿')).toBeNull()
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

    it('显示字数统计', async () => {
        renderPage()
        await waitFor(() => {
            expect(screen.getByText('字数 18')).toBeTruthy()
        })
    })

    it('有 P0 冲突时禁用审批通过按钮', async () => {
        renderPage()
        await waitFor(() => {
            expect(screen.getByText('审批通过')).toBeTruthy()
        })
        expect(screen.getByText('审批通过')).toHaveProperty('disabled', true)
    })

    /* ── Toast 通知 ── */

    it('加载失败时触发 error Toast', async () => {
        mockApiGet.mockRejectedValue(new Error('网络错误'))
        renderPage()
        await waitFor(() => {
            expect(mockAddToast).toHaveBeenCalledWith('error', '加载章节失败，请稍后重试')
        })
    })

    it('蓝图生成成功时触发 success Toast', async () => {
        mockApiPost.mockResolvedValue({ data: {} })
        renderPage()
        await waitFor(() => {
            expect(screen.getByText('重新生成蓝图')).toBeTruthy()
        })
        fireEvent.click(screen.getByText('重新生成蓝图'))
        await waitFor(() => {
            expect(mockAddToast).toHaveBeenCalledWith('success', '蓝图生成成功')
        })
    })

    it('蓝图生成失败时触发 error Toast', async () => {
        mockApiPost.mockRejectedValue(new Error('后端错误'))
        renderPage()
        await waitFor(() => {
            expect(screen.getByText('重新生成蓝图')).toBeTruthy()
        })
        fireEvent.click(screen.getByText('重新生成蓝图'))
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
            expect(screen.getByText('重新生成蓝图')).toBeTruthy()
        })
        fireEvent.click(screen.getByText('重新生成蓝图'))
        await waitFor(() => {
            expect(mockAddToast).toHaveBeenCalledWith('warning', '蓝图质量告警', expect.objectContaining({
                context: expect.stringContaining('质量分 61'),
            }))
        })
    })

    /* ── 编辑模式 ── */

    it('默认进入编辑模式并可切换到预览', async () => {
        renderPage()
        await waitFor(() => {
            expect(screen.getByText('预览正文')).toBeTruthy()
        })
        fireEvent.click(screen.getByText('预览正文'))
        expect(screen.getByText('返回编辑')).toBeTruthy()
        expect(screen.getByText('保存编辑并重检')).toBeTruthy()
    })

    it('清空创作台仅清空本地编辑区，不触发保存接口', async () => {
        renderPage()
        await waitFor(() => {
            expect(screen.getByText('清空创作台')).toBeTruthy()
        })

        const editor = document.querySelector('textarea[rows="22"]') as HTMLTextAreaElement
        expect(editor).toBeTruthy()
        fireEvent.change(editor, { target: { value: '临时编辑内容' } })
        expect(editor.value).toBe('临时编辑内容')

        fireEvent.click(screen.getByText('清空创作台'))
        expect(screen.getByText('清空当前创作台？')).toBeTruthy()
        fireEvent.click(screen.getByText('确认清空'))

        const clearedEditor = document.querySelector('textarea[rows="22"]') as HTMLTextAreaElement
        expect(clearedEditor.value).toBe('')
        expect(mockApiPut).not.toHaveBeenCalled()
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
                expect(screen.getByText('预览正文')).toBeTruthy()
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

            // Should be in editing mode with restored content
            expect(screen.getByText('预览正文')).toBeTruthy()
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
