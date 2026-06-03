import { Loader2, X } from 'lucide-react'
import type { LocalHistoryDetail, LocalHistoryRecord } from '../api'
import type { DownloadableItem, DownloaderConfig } from '../lib/downloaders'
import { downloadableFromHistoryRecord } from '../lib/history'
import type { NotificationInput } from '../state'
import { HistoryDetailContent } from './HistoryDetailContent'
import { EmptyState, MiddleEllipsis } from './ui'

export function HistoryDetailDrawer({
  detail,
  downloaders,
  loading,
  open,
  reparsePending,
  sending,
  onClose,
  onReparse,
  onSend,
  onNotify,
}: {
  detail?: LocalHistoryDetail
  downloaders: DownloaderConfig[]
  loading: boolean
  open: boolean
  reparsePending: boolean
  sending: boolean
  onClose: () => void
  onReparse: (record: LocalHistoryRecord) => void
  onSend: (downloader: DownloaderConfig, items: DownloadableItem[]) => void
  onNotify?: (input: NotificationInput) => void
}) {
  const record = detail?.record
  const downloadable = record ? downloadableFromHistoryRecord(record) : null

  return (
    <div className={`fixed inset-0 z-40 ${open ? '' : 'pointer-events-none'}`} aria-hidden={!open}>
      <button
        aria-label="关闭历史详情"
        className={`absolute inset-0 bg-slate-950/30 transition-opacity ${open ? 'opacity-100' : 'opacity-0'}`}
        onClick={onClose}
        tabIndex={open ? 0 : -1}
        type="button"
      />
      <aside
        className={`absolute right-0 top-0 flex h-full w-full max-w-[560px] flex-col border-l border-slate-200 bg-white shadow-2xl shadow-slate-950/20 transition-transform duration-200 max-sm:max-w-none ${open ? 'translate-x-0' : 'translate-x-full'}`}
        role="dialog"
        aria-modal="true"
        aria-label="历史详情"
      >
        <div className="flex items-start gap-3 border-b border-slate-200 px-5 py-4">
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-bold text-slate-900">历史详情</h3>
            {record ? <MiddleEllipsis text={record.filename} className="mt-1 text-sm text-slate-500" maxWidthPx={420} /> : null}
          </div>
          <button className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" type="button" aria-label="关闭" onClick={onClose}>
            <X className="size-5" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          {loading && !detail ? (
            <div className="flex min-h-40 items-center justify-center gap-2 text-sm text-slate-500">
              <Loader2 className="size-4 animate-spin" />
              加载中
            </div>
          ) : detail ? (
            <HistoryDetailContent
              detail={detail}
              downloaders={downloaders}
              downloadable={downloadable}
              onReparse={onReparse}
              onSend={onSend}
              onNotify={onNotify}
              reparsePending={reparsePending}
              sending={sending}
            />
          ) : (
            <EmptyState title="没有详情数据" />
          )}
        </div>
      </aside>
    </div>
  )
}
