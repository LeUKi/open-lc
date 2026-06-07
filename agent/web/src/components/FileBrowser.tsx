import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react'
import { useAtom, useSetAtom } from 'jotai'
import {
  CheckSquare,
  ChevronDown,
  ChevronRight,
  Download,
  File,
  Folder,
  FolderOpen,
  Loader2,
  RefreshCw,
  Square,
  HardDrive,
  Link2,
  ListChecks,
  Sparkles,
  X,
} from 'lucide-react'
import { api, honoClient, messageFromError, type LocalAccount, type ParseJob, type ShareFile } from '../api'
import {
  diskFilesAtom,
  errorAtom,
  executionOpenAtom,
  parseQueueAtom,
  parseResultsAtom,
  pushNotificationAtom,
  selectedFilesAtom,
  shareDirectoryCookieAtom,
  workspaceContextAtom,
  workspaceNodesAtom,
  type ParseResult,
  type QueuedFile,
  type SelectedFile,
  type WorkspaceDirectoryNode,
} from '../state'
import { formatBytes, formatDateTime, joinPath, parsePwd, pathParts } from '../lib/format'
import { parseDownloaders, serializeDownloaders } from '../lib/downloaders'
import { Button, EmptyState, Field, HoverTooltip, Input, MiddleEllipsis, Modal, Panel, Select, Textarea } from './ui'
import { ParseExecutionDrawer } from './ParseExecutionDrawer'

const PAGE_SIZE = 50

type DirectoryNode = WorkspaceDirectoryNode

type MergedDirectoryView = {
  label: string
  dir: string
  node?: DirectoryNode
}

type LoadDirectoryOptions = {
  append?: boolean
  expand?: boolean
  resetWorkspace?: boolean
  activate?: boolean
}

type PendingShareDirectoryLoad = {
  dir: string
  options?: LoadDirectoryOptions
}

type ShareDirectoryIssue = {
  message: string
  dir: string
  options?: LoadDirectoryOptions
  kind: 'credential' | 'path' | 'other'
}

function ModeSegmentedControl({ value, onChange }: { value: 'share' | 'disk'; onChange: (value: 'share' | 'disk') => void }) {
  const items = [
    { value: 'share' as const, label: '分享浏览', icon: Link2 },
    { value: 'disk' as const, label: '网盘浏览', icon: HardDrive },
  ]

  return (
    <div className="flex rounded-lg bg-slate-100 p-1">
      {items.map((item) => {
        const Icon = item.icon
        const active = value === item.value
        return (
          <button
            className={`flex min-h-9 flex-1 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-semibold transition ${active ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}
            key={item.value}
            onClick={() => onChange(item.value)}
            type="button"
          >
            <Icon className="size-4" />
            <span>{item.label}</span>
          </button>
        )
      })}
    </div>
  )
}

const emptyNode = (dir: string): DirectoryNode => ({
  dir,
  files: [],
  page: 0,
  hasMore: false,
  loading: false,
  error: null,
  expanded: false,
  loaded: false,
})

const fileDir = (file: ShareFile, fallbackDir: string) => {
  if (!file.path) return fallbackDir
  const index = file.path.lastIndexOf('/')
  return index <= 0 ? '/' : file.path.slice(0, index)
}

const selectedFromFile = (file: ShareFile, dir: string, mode: 'share' | 'disk', accountId?: number): SelectedFile => ({
  fsId: file.fs_id,
  filename: file.server_filename,
  size: file.size,
  dir: mode === 'disk' ? fileDir(file, dir) : dir,
  path: file.path,
  accountId,
})

const hasSelectedFsId = (selected: Map<number, SelectedFile>, fsId: number) => selected.has(fsId)

const directoryPathFor = (file: ShareFile, parentDir: string) => file.path || joinPath(parentDir, file.server_filename)

const treeIndentPx = (depth: number) => depth * 22

const directoryFiles = (node?: DirectoryNode) => (node?.files ?? []).filter((item) => !item.is_dir)

const canNavigateBreadcrumb = (path: string, nodes: Record<string, DirectoryNode>) => path === '/' || Boolean(nodes[path]?.loaded && !nodes[path]?.error)

const resolveMergedDirectory = (file: ShareFile, parentDir: string, nodes: Record<string, DirectoryNode>): MergedDirectoryView => {
  let label = file.server_filename
  let dir = directoryPathFor(file, parentDir)
  let node = nodes[dir]

  while (node?.loaded && !node.loading && !node.error && !node.hasMore && node.files.length === 1 && node.files[0]?.is_dir) {
    const onlyDir = node.files[0]
    label = `${label}/${onlyDir.server_filename}`
    dir = directoryPathFor(onlyDir, dir)
    node = nodes[dir]
  }

  return { label, dir, node }
}

const collapseBreadcrumbs = (dir: string, nodes: Record<string, DirectoryNode>) => {
  const parts = pathParts(dir)
  if (parts.length <= 2) return parts

  const merged = [parts[0]]
  let hiddenSegments: string[] = []
  for (let index = 1; index < parts.length; index += 1) {
    const current = parts[index]
    if (!canNavigateBreadcrumb(current.path, nodes)) {
      hiddenSegments.push(current.label)
      continue
    }

    const label = hiddenSegments.length > 0 ? `${hiddenSegments.join('/')}/${current.label}` : current.label
    hiddenSegments = []
    const previous = merged[merged.length - 1]
    if (previous.path !== '/' && previous.path === current.path) {
      merged[merged.length - 1] = {
        label: `${previous.label}/${label}`,
        path: current.path,
      }
      continue
    }

    merged.push({ label, path: current.path })
  }

  if (hiddenSegments.length > 0) {
    merged.push({
      label: hiddenSegments.join('/'),
      path: dir,
    })
  }

  return merged
}

const shareDirectoryIssueFromError = (error: unknown): Pick<ShareDirectoryIssue, 'message' | 'kind'> => {
  const message = messageFromError(error, '获取文件列表失败')
  if (message.includes('路径错误')) {
    return {
      kind: 'path',
      message: '该目录路径无法直接读取，请从上级目录重新进入。',
    }
  }
  if (message.includes('提取码错误')) return { kind: 'credential', message }
  if (message.includes('Cookie') || message.includes('响应格式异常') || message.includes('上游') || message.includes('请求失败')) {
    return { kind: 'credential', message }
  }
  return { kind: 'other', message }
}

export function ParserWorkspace() {
  const accountsQuery = api.api.local.accounts.$get.useQuery()
  const settingsQuery = api.api.settings.$get.useQuery()
  const settingsMutation = api.api.settings.$put.useMutation()
  const [context, setContext] = useAtom(workspaceContextAtom)
  const [selected, setSelected] = useAtom(selectedFilesAtom)
  const [queue, setQueue] = useAtom(parseQueueAtom)
  const [results, setResults] = useAtom(parseResultsAtom)
  const [, setDiskFiles] = useAtom(diskFilesAtom)
  const [nodes, setNodes] = useAtom(workspaceNodesAtom)
  const [shareCookie, setShareCookie] = useAtom(shareDirectoryCookieAtom)
  const [cookieModalOpen, setCookieModalOpen] = useState(false)
  const [cookieDraft, setCookieDraft] = useState(shareCookie)
  const [cookieDraftError, setCookieDraftError] = useState<string | null>(null)
  const [pendingShareDirectoryLoad, setPendingShareDirectoryLoad] = useState<PendingShareDirectoryLoad | null>(null)
  const [shareDirectoryIssue, setShareDirectoryIssue] = useState<ShareDirectoryIssue | null>(null)
  const [executionOpen, setExecutionOpen] = useAtom(executionOpenAtom)
  const setError = useSetAtom(errorAtom)
  const pushNotification = useSetAtom(pushNotificationAtom)
  const shareFilesMutation = api.api.local.browser.share.$post.useMutation()
  const shareCookieTemplateQuery = api.api.local.browser['share-cookie-template'].$get.useQuery()
  const submitJobMutation = api.api.local.parse.jobs.$post.useMutation()
  const diskResolveMutation = api.api.local.browser.disk.resolve.$post.useMutation()
  const currentNode = nodes[context.dir]
  const localAccounts = accountsQuery.data?.data ?? []
  const activeLocalAccounts = localAccounts.filter((item) => item.status === 'active')
  const executionCount = queue.length + results.length
  const downloaders = parseDownloaders(settingsQuery.data?.data.items.downloadersJson?.value)
  const fakeCookieTemplate = shareCookieTemplateQuery.data?.data.fakeCookie ?? ''
  const cookieModalIsContinuation = Boolean(pendingShareDirectoryLoad)
  const cookieModalTitle = cookieModalIsContinuation ? '继续读取分享目录' : '目录访问设置'
  const cookieModalDescription = cookieModalIsContinuation
    ? '为了获取分享目录中的文件列表，需要补充请求所需的访问凭证。'
    : '这里可以更新用于读取分享目录文件列表的访问凭证。'
  const queueRef = useRef(queue)

  useEffect(() => {
    queueRef.current = queue
  }, [queue])

  const setQueueAndRef = (updater: QueuedFile[] | ((prev: QueuedFile[]) => QueuedFile[])) => {
    setQueue((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater
      queueRef.current = next
      return next
    })
  }

  const deleteWaitingQueueItem = (fsId: number) => {
    setQueueAndRef((prev) => prev.filter((item) => item.fsId !== fsId || item.status !== 'waiting'))
  }

  const isStillWaiting = (fsId: number) => queueRef.current.some((item) => item.fsId === fsId && item.status === 'waiting')

  const setDefaultDownloader = async (downloaderId: string) => {
    const next = downloaders.map((item) => ({ ...item, isDefault: item.id === downloaderId }))
    try {
      await settingsMutation.mutateAsync({
        json: {
          values: {
            downloadersJson: serializeDownloaders(next),
          },
        },
      })
      await settingsQuery.refetch()
      // pushNotification({
      //   variant: 'success',
      //   message: '默认下载器已切换',
      // })
    } catch (error) {
      setError(messageFromError(error, '切换默认下载器失败'))
    }
  }

  const setNode = (dir: string, updater: (node: DirectoryNode) => DirectoryNode) => {
    setNodes((prev) => ({
      ...prev,
      [dir]: updater(prev[dir] ?? emptyNode(dir)),
    }))
  }

  const loadDiskDirectory = async (dir: string, options?: LoadDirectoryOptions) => {
    if (context.accountId <= 0) {
      setError('请先选择一个账号')
      return
    }
    const append = options?.append === true
    const previous = nodes[dir]
    const page = append ? (previous?.page ?? 0) + 1 : 1
    setError(null)
    setNode(dir, (node) => ({
      ...node,
      loading: true,
      error: null,
      expanded: options?.expand ?? node.expanded,
    }))
    try {
      const response = await honoClient.api.local.browser.disk[':id'].$get({
        param: { id: String(context.accountId) },
        query: {
          dir,
          page: String(page),
          pageSize: String(PAGE_SIZE),
          order: 'filename',
        },
      })
      if (!response.ok) throw new Error('网盘目录读取失败')
      const json = await response.json()
      const list = json.data.list ?? []
      let nextFiles: ShareFile[] = []
      setNode(dir, (node) => {
        nextFiles = append ? [...node.files, ...list] : list
        return {
          ...node,
          files: nextFiles,
          page,
          hasMore: list.length === PAGE_SIZE,
          loading: false,
          error: null,
          expanded: options?.expand ?? node.expanded,
          loaded: true,
        }
      })
      setDiskFiles(nextFiles)
      if (options?.activate !== false) {
        setContext((prev) => ({
          ...prev,
          dir,
          paths: pathParts(dir).map((item) => item.path),
        }))
      }
      if (options?.resetWorkspace) {
        setSelected(new Map())
      }
    } catch (error) {
      const message = messageFromError(error, '获取网盘文件列表失败')
      setNode(dir, (node) => ({
        ...node,
        loading: false,
        error: message,
      }))
      setError(message)
    }
  }

  const openCookieModal = (dir: string, options?: LoadDirectoryOptions) => {
    setCookieDraft(shareCookie)
    setCookieDraftError(null)
    setPendingShareDirectoryLoad({ dir, options })
    setCookieModalOpen(true)
  }

  const openCookieManager = () => {
    setCookieDraft(shareCookie)
    setCookieDraftError(null)
    setPendingShareDirectoryLoad(null)
    setCookieModalOpen(true)
  }

  const openCookieRetryModal = (issue: ShareDirectoryIssue) => {
    setCookieDraft(shareCookie)
    setCookieDraftError(null)
    setPendingShareDirectoryLoad({ dir: issue.dir, options: issue.options })
    setCookieModalOpen(true)
  }

  const navigateToIssueParent = async (issue: ShareDirectoryIssue) => {
    const parent = pathParts(issue.dir).at(-2)?.path ?? '/'
    setShareDirectoryIssue(null)
    await loadDirectory(parent)
  }

  const loadShareDirectoryWithCookie = async (dir: string, options: LoadDirectoryOptions | undefined, cookie: string) => {
    const shareUrl = context.shareUrl.trim()
    if (!shareUrl) {
      setError('请先输入百度网盘分享链接')
      return
    }

    const normalizedCookie = cookie.trim()
    if (!normalizedCookie) {
      openCookieModal(dir, options)
      return
    }

    const append = options?.append === true
    const previous = nodes[dir]
    const page = append ? (previous?.page ?? 0) + 1 : 1
    const pwd = context.pwd.trim()
    setError(null)
    if (options?.resetWorkspace) {
      setNodes({})
      setDiskFiles([])
    }
    setNode(dir, (node) => ({
      ...node,
      loading: true,
      error: null,
      expanded: options?.expand ?? node.expanded,
    }))

    try {
      const response = await shareFilesMutation.mutateAsync({
        json: {
          shareUrl,
          cookie: normalizedCookie,
          pwd,
          dir,
          page,
          num: PAGE_SIZE,
          order: 'filename',
        },
      })
      const list = response.data.list ?? []
      setNode(dir, (node) => ({
        ...node,
        files: append ? [...node.files, ...list] : list,
        page,
        hasMore: list.length === PAGE_SIZE,
        loading: false,
        error: null,
        expanded: options?.expand ?? node.expanded,
        loaded: true,
      }))
      if (options?.activate !== false) {
        setContext((prev) => ({
          ...prev,
          dir,
          paths: pathParts(dir).map((item) => item.path),
        }))
      }
      if (options?.resetWorkspace) {
        setSelected(new Map())
      }
      setShareDirectoryIssue(null)
    } catch (error) {
      const issueDetail = shareDirectoryIssueFromError(error)
      const issue = {
        message: issueDetail.message,
        kind: issueDetail.kind,
        dir,
        options,
      }
      setNode(dir, (node) => ({
        ...node,
        loading: false,
        error: issueDetail.message,
      }))
      setShareDirectoryIssue(issue)
      setError(issueDetail.message)
    }
  }

  const loadShareDirectory = async (dir: string, options?: LoadDirectoryOptions) => {
    const shareUrl = context.shareUrl.trim()
    if (!shareUrl) {
      setError('请先输入百度网盘分享链接')
      return
    }

    const normalizedCookie = shareCookie.trim()
    if (!normalizedCookie) {
      setError(null)
      openCookieModal(dir, options)
      return
    }

    await loadShareDirectoryWithCookie(dir, options, normalizedCookie)
  }

  const closeCookieModal = () => {
    setCookieModalOpen(false)
    setPendingShareDirectoryLoad(null)
    setCookieDraftError(null)
  }

  const saveCookieAndContinue = async () => {
    const normalizedCookie = cookieDraft.trim()
    if (!normalizedCookie) {
      setCookieDraftError('请填写用于读取分享目录的 Cookie')
      return
    }

    const pendingLoad = pendingShareDirectoryLoad
    setShareCookie(normalizedCookie)
    setCookieModalOpen(false)
    setPendingShareDirectoryLoad(null)
    setCookieDraftError(null)
    if (!pendingLoad) {
      setShareDirectoryIssue(null)
    }

    if (pendingLoad) {
      await loadShareDirectoryWithCookie(pendingLoad.dir, pendingLoad.options, normalizedCookie)
    }
  }

  const loadDirectory = async (dir: string, options?: LoadDirectoryOptions) => {
    if (context.mode === 'disk') {
      await loadDiskDirectory(dir, options)
      return
    }
    await loadShareDirectory(dir, options)
  }

  const refreshRoot = async () => {
    if (context.mode === 'disk') {
      setNodes({})
      setDiskFiles([])
    }
    await loadDirectory('/', { resetWorkspace: true })
  }

  const enterDirectory = async (file: ShareFile, parentDir: string) => {
    if (!file.is_dir) return
    const nextDir = file.path || joinPath(parentDir, file.server_filename)
    await loadDirectory(nextDir)
  }

  const toggleDirectory = async (file: ShareFile, parentDir: string) => {
    if (!file.is_dir) return
    const dir = file.path || joinPath(parentDir, file.server_filename)
    const node = nodes[dir]
    if (node?.expanded) return
    setNode(dir, (current) => ({ ...current, expanded: true }))
    if (!node?.loaded) await loadDirectory(dir, { expand: true, activate: false })
  }

  const loadMore = async (dir: string) => {
    if (context.mode === 'disk') {
      await loadDiskDirectory(dir, { append: true, expand: nodes[dir]?.expanded, activate: false })
      return
    }
    await loadShareDirectory(dir, { append: true, expand: nodes[dir]?.expanded, activate: false })
  }

  const retryDirectory = async (dir: string) => {
    await loadDirectory(dir, { expand: true, activate: false })
  }

  const toggleFile = (file: ShareFile, dir: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Map(prev)
      if (checked) next.set(file.fs_id, selectedFromFile(file, dir, context.mode, context.mode === 'disk' ? context.accountId : undefined))
      else next.delete(file.fs_id)
      return next
    })
  }

  const toggleDirectorySelection = (dir: string, checked: boolean) => {
    const files = (nodes[dir]?.files ?? []).filter((item) => !item.is_dir)
    setSelected((prev) => {
      const next = new Map(prev)
      for (const file of files) {
        if (checked) next.set(file.fs_id, selectedFromFile(file, dir, context.mode, context.mode === 'disk' ? context.accountId : undefined))
        else next.delete(file.fs_id)
      }
      return next
    })
  }

  const buildQueue = () => {
    const next = Array.from(selected.values()).map((file) => ({
      fsId: file.fsId,
      filename: file.filename,
      size: file.size,
      dir: file.dir,
      accountId: file.accountId,
      status: 'waiting' as const,
    }))
    setQueueAndRef(next)
    return next
  }

  const statusFromJob = (job: ParseJob): QueuedFile['status'] =>
    job.status === 'running' ? 'running' : job.status === 'success' ? 'success' : job.status === 'failed' ? 'failed' : 'queued'

  const messageFromJob = (job: ParseJob) => {
    if (job.status === 'queued') return `排队中，前面还有 ${job.ahead_count} 个任务`
    if (job.status === 'running') return '解析中'
    if (job.status === 'success') return '解析成功'
    return job.errorMessage ?? job.errorCode ?? '解析失败'
  }

  const pollJob = async (job: ParseJob, onUpdate: (next: ParseJob) => void) => {
    let current = job
    while (current.status === 'queued' || current.status === 'running') {
      await new Promise((resolve) => setTimeout(resolve, 1000))
      const response = await honoClient.api.local.parse.jobs[':id'].$get({
        param: { id: String(job.id) },
      })
      if (!response.ok) throw new Error('任务状态查询失败')
      const polled = await response.json()
      current = polled.data
      onUpdate(current)
    }
    return current
  }

  const appendResult = async (item: Pick<QueuedFile, 'fsId' | 'filename'>, current: ParseJob, prepend = false) => {
    const addResult = (result: ParseResult) => {
      setResults((prev) => (prepend ? [result, ...prev] : [...prev, result]))
    }

    if (current.status === 'success' && current.result) {
      const result: ParseResult = {
        fsId: item.fsId,
        filename: item.filename,
        status: 'success',
        message: '解析成功',
        data: {
          ...current.result,
          link_expires_at: current.result.link_expires_at ?? null,
        },
        job: current,
      }
      addResult(result)
      await api.api.local.history.$get.invalidate()
      return
    }

    addResult({
      fsId: item.fsId,
      filename: item.filename,
      status: 'failed',
      message: current.errorMessage ?? current.errorCode ?? '解析失败',
      job: current,
    })
  }

  const runSubmittedJob = async (item: Pick<QueuedFile, 'fsId' | 'filename'>, job: ParseJob, prependResult = false) => {
    setQueueAndRef((prev) =>
      prev.map((row) =>
        row.fsId === item.fsId
          ? {
              ...row,
              status: statusFromJob(job),
              jobId: job.id,
              aheadCount: job.ahead_count,
              message: messageFromJob(job),
            }
          : row,
      ),
    )

    const current = await pollJob(job, (next) => {
      setQueueAndRef((prev) =>
        prev.map((row) =>
          row.fsId === item.fsId
            ? {
                ...row,
                status: statusFromJob(next),
                jobId: next.id,
                aheadCount: next.ahead_count,
                message: messageFromJob(next),
              }
            : row,
        ),
      )
    })

    await appendResult(item, current, prependResult)
  }

  const parseSelected = async () => {
    const pending = buildQueue()
    if (pending.length === 0) return
    setExecutionOpen(true)
    setResults([])
    if (activeLocalAccounts.length === 0) {
      setError('当前没有可用账号')
      return
    }
    setError(null)

    for (const item of pending) {
      if (!isStillWaiting(item.fsId)) continue
      setQueueAndRef((prev) => prev.map((row) => (row.fsId === item.fsId ? { ...row, status: 'queued', message: '提交任务中' } : row)))
      try {
        if (context.mode === 'disk') {
          const response = await diskResolveMutation.mutateAsync({
            json: {
              accountId: item.accountId || context.accountId,
              fsId: item.fsId,
              path: item.dir === '/' ? `/${item.filename}` : `${item.dir}/${item.filename}`,
              filename: item.filename,
              sizeBytes: item.size,
            },
          })
          const data = response.data
          setQueueAndRef((prev) =>
            prev.map((row) =>
              row.fsId === item.fsId
                ? {
                    ...row,
                    status: 'success',
                    message: '网盘取链成功',
                  }
                : row,
            ),
          )
          setResults((prev) => [
            ...prev,
            {
              fsId: item.fsId,
              filename: item.filename,
              status: 'success',
              message: '网盘取链成功',
              data,
            },
          ])
          await api.api.local.history.$get.invalidate()
          continue
        }

        const submitted = await submitJobMutation.mutateAsync({
          json: {
            shareUrl: context.shareUrl.trim(),
            pwd: context.pwd.trim(),
            dir: item.dir ?? '/',
            fsIds: [item.fsId],
          },
        })
        await runSubmittedJob(item, submitted.data)
      } catch (error) {
        const message = messageFromError(error, '解析失败')
        setQueueAndRef((prev) =>
          prev.map((row) =>
            row.fsId === item.fsId
              ? {
                  ...row,
                  status: 'failed',
                  message,
                }
              : row,
          ),
        )
        setResults((prev) => [
          ...prev,
          {
            fsId: item.fsId,
            filename: item.filename,
            status: 'failed',
            message,
          },
        ])
      }
    }
  }

  const selectedList = Array.from(selected.values())
  const setWorkspaceMode = (mode: 'share' | 'disk') => {
    setContext((prev) => ({
      ...prev,
      mode,
      dir: '/',
      paths: ['/'],
    }))
  }

  return (
    <>
      <div className="grid gap-5">
        <Panel className="grid gap-5">
          <div className="grid gap-4">
            <div>
              <h2 className="text-xl font-bold">工作台</h2>
            </div>
            <div
              className={`grid gap-3 ${context.mode === 'share' ? 'md:grid-cols-[220px_minmax(0,1fr)_120px]' : 'md:grid-cols-[220px_220px_minmax(240px,1fr)]'}`}
            >
              <Field label="浏览模式">
                <ModeSegmentedControl value={context.mode} onChange={setWorkspaceMode} />
              </Field>
              {context.mode === 'share' ? (
                <>
                  <Field label="分享链接">
                    <Input
                      className="w-full"
                      value={context.shareUrl}
                      onChange={(event: ChangeEvent<HTMLInputElement>) => {
                        const shareUrl = event.target.value
                        const detected = parsePwd(shareUrl)
                        setContext((prev) => ({ ...prev, shareUrl, pwd: detected }))
                      }}
                      placeholder="https://pan.xxx.com/s/1..."
                    />
                  </Field>
                  <Field label="提取码">
                    <Input
                      className="w-full"
                      maxLength={4}
                      value={context.pwd}
                      onChange={(event: ChangeEvent<HTMLInputElement>) => setContext((prev) => ({ ...prev, pwd: event.target.value }))}
                      placeholder="可留空"
                    />
                  </Field>
                </>
              ) : (
                <>
                  <Field label="账号">
                    <Select
                      className="w-full"
                      value={String(context.accountId)}
                      onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                        setContext((prev) => ({ ...prev, accountId: Number(event.target.value), dir: '/', paths: ['/'] }))
                      }
                    >
                      <option value="0">选择账号</option>
                      {activeLocalAccounts.map((account) => (
                        <option key={account.id} value={account.id}>
                          {account.baiduName || account.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="当前目录">
                    <Input
                      className="w-full"
                      value={context.dir}
                      onChange={(event: ChangeEvent<HTMLInputElement>) => setContext((prev) => ({ ...prev, dir: event.target.value }))}
                    />
                  </Field>
                </>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button disabled={shareFilesMutation.isPending || Boolean(currentNode?.loading)} onClick={refreshRoot}>
                {shareFilesMutation.isPending || currentNode?.loading ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : context.mode === 'disk' ? (
                  <HardDrive className="size-4" />
                ) : (
                  <FolderOpen className="size-4" />
                )}
                {context.mode === 'disk' ? '读取网盘目录' : '读取分享目录'}
              </Button>
              {context.mode === 'share' ? (
                <Button onClick={openCookieManager} variant="secondary">
                  目录访问设置
                </Button>
              ) : null}
              <Button
                disabled={selectedList.length === 0 || submitJobMutation.isPending || diskResolveMutation.isPending}
                onClick={parseSelected}
                variant="secondary"
              >
                <Download className="size-4" />
                解析 {selectedList.length ? `${selectedList.length} 个` : ''}
              </Button>
              {selectedList.length > 0 ? (
                <Button onClick={() => setSelected(new Map())} size="sm" variant="secondary">
                  <X className="size-4" />
                  取消选择
                </Button>
              ) : null}
              <Button onClick={() => setExecutionOpen(true)} variant="secondary">
                <ListChecks className="size-4" />
                执行面板
                {executionCount > 0 ? (
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600 ring-1 ring-slate-200">{executionCount}</span>
                ) : null}
              </Button>
              {selectedList.length > 0 ? (
                <span className="text-sm text-slate-500">
                  已选 {selectedList.length} 个，合计 {formatBytes(selectedList.reduce((sum, file) => sum + file.size, 0))}
                </span>
              ) : null}
              <span className={`inline-flex items-center gap-1 text-sm ${activeLocalAccounts.length > 0 ? 'text-emerald-700' : 'text-red-600'}`}>
                {activeLocalAccounts.length > 0 ? `可用账号 ${activeLocalAccounts.length} 条` : '当前没有可用账号'}
              </span>
            </div>
            {context.mode === 'share' && shareDirectoryIssue ? (
              <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900">
                <div className="min-w-0">
                  <div className="font-bold">分享目录读取失败</div>
                  <div>{shareDirectoryIssue.message}</div>
                </div>
                {shareDirectoryIssue.kind === 'path' ? (
                  <Button className="shrink-0" onClick={() => void navigateToIssueParent(shareDirectoryIssue)} size="sm" variant="secondary">
                    返回上级目录
                  </Button>
                ) : shareDirectoryIssue.kind === 'credential' ? (
                  <Button className="shrink-0" onClick={() => openCookieRetryModal(shareDirectoryIssue)} size="sm" variant="secondary">
                    更新访问凭证
                  </Button>
                ) : (
                  <Button
                    className="shrink-0"
                    onClick={() => void loadDirectory(shareDirectoryIssue.dir, shareDirectoryIssue.options)}
                    size="sm"
                    variant="secondary"
                  >
                    重试
                  </Button>
                )}
              </div>
            ) : null}
          </div>
          <BrowserHeader dir={context.dir} nodes={nodes} onNavigate={(dir) => loadDirectory(dir)} />
          <FileTree
            currentDir={context.dir}
            node={currentNode}
            nodes={nodes}
            selected={selected}
            onEnter={enterDirectory}
            onLoadMore={loadMore}
            onRetryDirectory={retryDirectory}
            onToggleDirectory={toggleDirectory}
            onToggleDirectorySelection={toggleDirectorySelection}
            onToggleFile={toggleFile}
          />
        </Panel>
      </div>
      <ParseExecutionDrawer
        downloaders={downloaders}
        open={executionOpen}
        queue={queue}
        results={results}
        onNotify={pushNotification}
        onError={setError}
        onDefaultDownloaderChange={(downloaderId) => void setDefaultDownloader(downloaderId)}
        onDeleteWaitingItem={deleteWaitingQueueItem}
        onClose={() => setExecutionOpen(false)}
      />
      <Modal description={cookieModalDescription} maxWidthClassName="max-w-3xl" onClose={closeCookieModal} open={cookieModalOpen} title={cookieModalTitle}>
        <div className="grid gap-4">
          <Field label="Cookie" hint={pendingShareDirectoryLoad ? '填写后点击保存并继续，当前这次目录读取会立即重试。' : '填写后点击保存即可更新。'}>
            <Textarea
              className="min-h-20 w-full min-w-0 resize-y font-mono text-xs"
              onChange={(event: ChangeEvent<HTMLTextAreaElement>) => {
                setCookieDraft(event.target.value)
                if (cookieDraftError) setCookieDraftError(null)
              }}
              value={cookieDraft}
            />
          </Field>
          {cookieDraftError ? <div className="text-sm font-semibold text-red-600">{cookieDraftError}</div> : null}
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-800">
            <div className="font-bold">合规提示</div>
            <div>请仅填写通过合法合规渠道取得、且你有权用于读取该分享目录的 Cookie。一般不建议填写他人账号、来源不明账号或未经授权的 Cookie。</div>
          </div>
          <div className="grid gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm font-semibold text-slate-700">来源未知的内置示例 Cookie</div>
              <button
                className="bling-fill-button group relative inline-flex min-h-8 max-w-full items-center justify-center gap-1.5 overflow-visible rounded-md bg-gradient-to-r from-blue-600 via-indigo-600 to-violet-600 px-3 py-1.5 text-xs font-bold text-white shadow-sm shadow-indigo-500/30 outline-none transition hover:from-blue-500 hover:via-indigo-500 hover:to-violet-500 hover:shadow-md hover:shadow-indigo-500/40 focus-visible:ring-2 focus-visible:ring-indigo-200 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={shareCookieTemplateQuery.isPending || !fakeCookieTemplate}
                onClick={() => {
                  setCookieDraft(fakeCookieTemplate)
                  if (cookieDraftError) setCookieDraftError(null)
                }}
                type="button"
              >
                <span className="bling-fill-glow absolute inset-0 -z-10 rounded-md bg-indigo-400/30 blur-md group-disabled:hidden" />
                <Sparkles className="bling-fill-sparkle size-3.5" />
                一键填充示例
              </button>
            </div>
            <Textarea
              className="min-h-16 w-full min-w-0 resize-y font-mono text-xs text-slate-600"
              readOnly
              value={shareCookieTemplateQuery.isPending ? '正在读取内置模板...' : fakeCookieTemplate}
            />
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <Button onClick={closeCookieModal} variant="secondary">
              取消
            </Button>
            <Button disabled={shareFilesMutation.isPending} onClick={() => void saveCookieAndContinue()}>
              {shareFilesMutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
              {pendingShareDirectoryLoad ? '保存并继续' : '保存'}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  )
}

function BrowserHeader({ dir, nodes, onNavigate }: { dir: string; nodes: Record<string, DirectoryNode>; onNavigate: (dir: string) => Promise<void> }) {
  const crumbs = collapseBreadcrumbs(dir, nodes)
  return (
    <div className="flex flex-wrap items-center gap-1 rounded-lg bg-slate-50 px-3 py-2 text-sm max-[768px]:flex-nowrap max-[768px]:overflow-x-auto max-[768px]:px-2 mobile-scrollbar-none">
      {crumbs.map((item, index) => (
        <div className="flex min-w-0 shrink-0 items-center gap-1" key={item.path}>
          {index > 0 ? <ChevronRight className="size-4 text-slate-400" /> : null}
          <button
            className={`min-w-0 rounded px-2 py-1 font-semibold ${item.path === dir ? 'text-slate-900' : 'text-blue-700 hover:bg-blue-50'}`}
            disabled={item.path === dir}
            type="button"
            onClick={() => onNavigate(item.path)}
          >
            {item.label === '全部文件' ? item.label : <MiddleEllipsis text={item.label} maxWidthPx={220} mobileMaxWidthPx={140} />}
          </button>
        </div>
      ))}
    </div>
  )
}

function FileTree({
  currentDir,
  node,
  nodes,
  selected,
  onEnter,
  onLoadMore,
  onRetryDirectory,
  onToggleDirectory,
  onToggleDirectorySelection,
  onToggleFile,
}: {
  currentDir: string
  node?: DirectoryNode
  nodes: Record<string, DirectoryNode>
  selected: Map<number, SelectedFile>
  onEnter: (file: ShareFile, parentDir: string) => void
  onLoadMore: (dir: string) => void
  onRetryDirectory: (dir: string) => void
  onToggleDirectory: (file: ShareFile, parentDir: string) => void
  onToggleDirectorySelection: (dir: string, checked: boolean) => void
  onToggleFile: (file: ShareFile, dir: string, checked: boolean) => void
}) {
  if (node?.loading && !node.loaded) return <EmptyState title="正在读取文件列表" />
  if (!node?.loaded) return <EmptyState title="还没有文件列表" />
  if (node.files.length === 0) return <EmptyState title="当前目录为空" />

  return (
    <div className="overflow-hidden rounded-lg border border-slate-200">
      <div className="grid grid-cols-[minmax(0,1fr)_120px_140px] bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-500 max-md:grid-cols-[minmax(0,1fr)_92px]">
        <div>名称</div>
        <div>大小</div>
        <div className="max-md:hidden">修改时间</div>
      </div>
      <div className="divide-y divide-slate-100">
        <DirectoryRows
          depth={0}
          dir={currentDir}
          node={node}
          nodes={nodes}
          selected={selected}
          onEnter={onEnter}
          onLoadMore={onLoadMore}
          onRetryDirectory={onRetryDirectory}
          onToggleDirectory={onToggleDirectory}
          onToggleDirectorySelection={onToggleDirectorySelection}
          onToggleFile={onToggleFile}
        />
      </div>
    </div>
  )
}

function DirectoryRows({
  depth,
  dir,
  node,
  nodes,
  selected,
  onEnter,
  onLoadMore,
  onRetryDirectory,
  onToggleDirectory,
  onToggleDirectorySelection,
  onToggleFile,
}: {
  depth: number
  dir: string
  node: DirectoryNode
  nodes: Record<string, DirectoryNode>
  selected: Map<number, SelectedFile>
  onEnter: (file: ShareFile, parentDir: string) => void
  onLoadMore: (dir: string) => void
  onRetryDirectory: (dir: string) => void
  onToggleDirectory: (file: ShareFile, parentDir: string) => void
  onToggleDirectorySelection: (dir: string, checked: boolean) => void
  onToggleFile: (file: ShareFile, dir: string, checked: boolean) => void
}) {
  return (
    <>
      {node.files.map((file) => {
        const merged = file.is_dir ? resolveMergedDirectory(file, dir, nodes) : null
        const childDir = merged?.dir ?? (file.is_dir ? file.path || joinPath(dir, file.server_filename) : '')
        const child = childDir ? nodes[childDir] : undefined
        return (
          <div key={`${dir}:${file.fs_id}`}>
            <FileRow
              depth={depth}
              dir={dir}
              file={file}
              merged={merged}
              selected={selected.has(file.fs_id)}
              selectedMap={selected}
              childNode={child}
              onEnter={onEnter}
              onLoadMore={onLoadMore}
              onToggleDirectory={onToggleDirectory}
              onToggleDirectorySelection={onToggleDirectorySelection}
              onToggleFile={onToggleFile}
            />
            {file.is_dir && child?.expanded ? (
              child.loading && !child.loaded ? (
                <IndentedRow depth={depth + 1}>
                  <Loader2 className="size-4 animate-spin text-blue-600" />
                  <span>正在加载子目录...</span>
                </IndentedRow>
              ) : child.error ? (
                <IndentedRow depth={depth + 1}>
                  <span className="text-red-600">{child.error}</span>
                  <Button className="min-h-8 px-2 py-1 text-xs" onClick={() => onRetryDirectory(childDir)} variant="secondary">
                    重试
                  </Button>
                </IndentedRow>
              ) : child.files.length > 0 ? (
                <DirectoryRows
                  depth={depth + 1}
                  dir={childDir}
                  node={child}
                  nodes={nodes}
                  selected={selected}
                  onEnter={onEnter}
                  onLoadMore={onLoadMore}
                  onRetryDirectory={onRetryDirectory}
                  onToggleDirectory={onToggleDirectory}
                  onToggleDirectorySelection={onToggleDirectorySelection}
                  onToggleFile={onToggleFile}
                />
              ) : (
                <IndentedRow depth={depth + 1}>子目录为空</IndentedRow>
              )
            ) : null}
          </div>
        )
      })}
      {node.hasMore ? (
        <IndentedRow depth={depth}>
          <Button className="min-h-9 px-3 py-1.5" disabled={node.loading} onClick={() => onLoadMore(dir)} variant="secondary">
            {node.loading ? <Loader2 className="size-4 animate-spin" /> : <ChevronDown className="size-4" />}
            加载更多
          </Button>
          <span className="text-xs text-slate-500">已加载 {node.files.length} 条</span>
        </IndentedRow>
      ) : null}
    </>
  )
}

function FileRow({
  depth,
  dir,
  file,
  merged,
  selected,
  selectedMap,
  childNode,
  onEnter,
  onLoadMore,
  onToggleDirectory,
  onToggleDirectorySelection,
  onToggleFile,
}: {
  depth: number
  dir: string
  file: ShareFile
  merged?: MergedDirectoryView | null
  selected: boolean
  selectedMap: Map<number, SelectedFile>
  childNode?: DirectoryNode
  onEnter: (file: ShareFile, parentDir: string) => void
  onLoadMore: (dir: string) => void
  onToggleDirectory: (file: ShareFile, parentDir: string) => void
  onToggleDirectorySelection: (dir: string, checked: boolean) => void
  onToggleFile: (file: ShareFile, dir: string, checked: boolean) => void
}) {
  const displayLabel = merged?.label ?? file.server_filename
  const childDir = merged?.dir ?? (file.is_dir ? directoryPathFor(file, dir) : '')
  const childFiles = directoryFiles(childNode)
  const allSelected = childFiles.length > 0 && childFiles.every((item) => hasSelectedFsId(selectedMap, item.fs_id))
  return (
    <div
      className={`grid min-h-14 grid-cols-[minmax(0,1fr)_120px_140px] items-center px-3 py-2 text-sm max-md:grid-cols-[minmax(0,1fr)_92px] ${file.is_dir ? 'bg-slate-50/40 hover:bg-slate-50' : 'hover:bg-slate-50/70'}`}
    >
      <div className="min-w-0" style={{ paddingLeft: `${treeIndentPx(depth)}px` }}>
        <div className="grid min-w-0 grid-cols-[36px_minmax(0,1fr)] items-center gap-2 rounded-md px-1 py-0.5">
          {file.is_dir ? (
            <HoverTooltip
              content={
                !childNode?.expanded
                  ? `展开 ${displayLabel} 并开始加载文件`
                  : !childNode?.loaded || childNode.loading
                    ? `正在加载 ${displayLabel}`
                    : childNode.error
                      ? `${displayLabel} 加载失败，点击重试`
                      : childNode.hasMore
                        ? `继续拉取 ${displayLabel}，加载完后才能整目录选择`
                        : childFiles.length === 0
                          ? `${displayLabel} 已完整加载，但当前层没有可选文件`
                          : `${displayLabel} 已完整加载，可一键选择当前层全部文件`
              }
            >
              <button
                aria-label={
                  !childNode?.expanded
                    ? '展开目录'
                    : !childNode?.loaded || childNode.loading
                      ? '正在加载目录'
                      : childNode.error
                        ? '重试目录加载'
                        : childNode.hasMore
                          ? '继续拉取目录'
                          : '选择目录中的文件'
                }
                className="flex h-8 w-8 items-center justify-center rounded text-slate-500 hover:bg-slate-100"
                type="button"
                onClick={() => {
                  if (!childNode?.expanded) {
                    void onToggleDirectory(file, dir)
                    return
                  }
                  if (!childNode.loaded || childNode.loading) return
                  if (childNode.error) {
                    void onLoadMore(childDir)
                    return
                  }
                  if (childNode.hasMore) {
                    void onLoadMore(childDir)
                    return
                  }
                  if (childFiles.length > 0) {
                    onToggleDirectorySelection(childDir, !allSelected)
                  }
                }}
              >
                {!childNode?.expanded ? (
                  <ChevronRight className="size-4" />
                ) : !childNode?.loaded || childNode.loading ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : childNode.error ? (
                  <RefreshCw className="size-4" />
                ) : childNode.hasMore ? (
                  <RefreshCw className="size-4" />
                ) : allSelected ? (
                  <CheckSquare className="size-5 text-blue-600" />
                ) : (
                  <Square className={`size-5 ${childFiles.length === 0 ? 'text-slate-300' : ''}`} />
                )}
              </button>
            </HoverTooltip>
          ) : (
            <button
              aria-label={selected ? '取消选择' : '选择文件'}
              className="flex h-8 w-8 items-center justify-center rounded text-slate-500 hover:bg-slate-100"
              type="button"
              onClick={() => onToggleFile(file, dir, !selected)}
            >
              {selected ? <CheckSquare className="size-5 text-blue-600" /> : <Square className="size-5" />}
            </button>
          )}
          <button
            className={`flex min-w-0 items-center gap-3 text-left ${file.is_dir ? 'font-semibold text-slate-900' : 'text-slate-800'}`}
            type="button"
            onClick={() => (file.is_dir ? onEnter({ ...file, path: childDir, server_filename: displayLabel }, dir) : onToggleFile(file, dir, !selected))}
          >
            <span
              className={`relative flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${file.is_dir ? 'bg-slate-200/80 text-slate-700' : 'bg-slate-100 text-slate-400'}`}
            >
              {depth > 0 ? <span className="absolute -left-2 top-1/2 h-px w-2 bg-slate-300" /> : null}
              {file.is_dir ? <Folder className="size-4.5" /> : <File className="size-4.5" />}
            </span>
            <MiddleEllipsis text={displayLabel} className={file.is_dir ? 'font-semibold text-slate-900' : 'font-medium text-slate-800'} />
          </button>
        </div>
      </div>
      <div className="text-slate-500">{file.is_dir ? '-' : formatBytes(file.size)}</div>
      <div className="text-slate-500 max-md:hidden">{formatDateTime(file.server_mtime ? file.server_mtime * 1000 : null)}</div>
    </div>
  )
}

function IndentedRow({ depth, children }: { depth: number; children: ReactNode }) {
  return (
    <div
      className="flex min-h-11 flex-wrap items-center gap-2 bg-slate-50/60 px-3 py-2 text-sm text-slate-500"
      style={{ paddingLeft: `${treeIndentPx(depth) + 48}px` }}
    >
      {children}
    </div>
  )
}
