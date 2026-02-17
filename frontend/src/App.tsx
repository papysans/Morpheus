import { lazy, Suspense } from 'react'
import { Routes, Route } from 'react-router-dom'
import AppLayout from './components/layout/AppLayout'
import ErrorBoundary from './components/ui/ErrorBoundary'
import Skeleton from './components/ui/Skeleton'

const ProjectList = lazy(() => import('./pages/ProjectList'))
const ProjectDetail = lazy(() => import('./pages/ProjectDetail'))
const WritingConsolePage = lazy(() => import('./pages/WritingConsolePage'))
const ChapterWorkbenchPage = lazy(() => import('./pages/ChapterWorkbenchPage'))
const MemoryBrowserPage = lazy(() => import('./pages/MemoryBrowserPage'))
const KnowledgeGraphPage = lazy(() => import('./pages/KnowledgeGraphPage'))
const TraceReplayPage = lazy(() => import('./pages/TraceReplayPage'))
const DashboardPage = lazy(() => import('./pages/DashboardPage'))

export default function App() {
  return (
    <ErrorBoundary>
      <Suspense fallback={<div className="app-layout__content"><Skeleton variant="card" count={3} /></div>}>
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="/" element={<ProjectList />} />
            <Route path="/project/:projectId" element={<ProjectDetail />} />
            <Route path="/project/:projectId/write" element={<WritingConsolePage />} />
            <Route path="/project/:projectId/chapter" element={<ChapterWorkbenchPage />} />
            <Route path="/project/:projectId/chapter/:chapterId" element={<ChapterWorkbenchPage />} />
            <Route path="/project/:projectId/memory" element={<MemoryBrowserPage />} />
            <Route path="/project/:projectId/graph" element={<KnowledgeGraphPage />} />
            <Route path="/project/:projectId/trace" element={<TraceReplayPage />} />
            <Route path="/project/:projectId/trace/:chapterId" element={<TraceReplayPage />} />
            <Route path="/dashboard" element={<DashboardPage />} />
          </Route>
        </Routes>
      </Suspense>
    </ErrorBoundary>
  )
}
