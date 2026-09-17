/**
 * 历史记录页面 - Surge 风格
 */

import {useEffect, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {type AnyClientId, type DiffResult, useElectronAPI} from '../lib/electron';
import {useIsMac} from '../lib/useIsMac';
import Modal from '../components/Modal';
import ClientIcon from '../components/ClientIcon';
import {toast} from '../components/Toast';
import WindowControls from '../components/WindowControls';

interface BackupInfo {
  timestamp: string;
  filename: string;
  size: number;
  /** 去重后的 MCP server 数（同一 server 装在多个客户端只计 1 次） */
  serverCount: number;
  /** 去重后的 Skill 数 */
  skillCount: number;
  /** 仅含真正承载内容的客户端（有 MCP server 或 Skill），不含未安装的空配置客户端 */
  clients: AnyClientId[];
}

/** 列表单行最多展示的客户端图标数，超出部分折叠为「+N」 */
const MAX_CLIENT_ICONS = 5;

/** 差异行：新增(+)/移除(-)/修改(~) 统一配色 */
function DiffChangeRow({id, kind, label}: { id: string; kind: 'added' | 'removed' | 'modified'; label?: string }) {
    const style = {
        added: {sign: '+', cls: 'bg-[#34c759]/10 border-[#34c759]/20 text-[#34c759]'},
        removed: {sign: '-', cls: 'bg-[#ff3b30]/10 border-[#ff3b30]/20 text-[#ff3b30]'},
        modified: {sign: '~', cls: 'bg-[#ff9f0a]/10 border-[#ff9f0a]/20 text-[#ff9f0a]'},
    }[kind];
    return (
        <div className={`flex items-center gap-2 px-3 py-2 rounded-md border ${style.cls}`}>
            <span className="text-[12px]">{style.sign}</span>
            <span className="text-[var(--color-text)] font-mono text-[12px]">{id}</span>
            {label && <span className="text-[12px] text-[var(--color-muted)]">{label}</span>}
        </div>
    );
}

export default function History() {
  const { t } = useTranslation();
  const api = useElectronAPI();
  const isMac = useIsMac();
  
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedDiff, setSelectedDiff] = useState<DiffResult | null>(null);
  const [isClearing, setIsClearing] = useState(false);

  useEffect(() => {
    loadBackups();
  }, []);

  const loadBackups = async (showToast = false) => {
    setIsLoading(true);
    try {
      const list = await api.history.list();
      setBackups(list);
      if (showToast) {
        toast.success(t('history.refreshed') || 'History refreshed');
      }
    } catch (error) {
      console.error('Failed to load backups:', error);
      if (showToast) {
        toast.error(t('history.refreshFailed') || 'Failed to refresh');
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleViewDiff = async (timestamp: string) => {
    try {
      const diff = await api.history.getDiff(timestamp);
      setSelectedDiff(diff);
    } catch (error) {
      console.error('Failed to get diff:', error);
    }
  };

  const formatTime = (timestamp: string) => {
    try {
      const date = new Date(timestamp);
      return date.toLocaleString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return timestamp;
    }
  };

  const formatRelativeTime = (timestamp: string) => {
    try {
      const date = new Date(timestamp);
      const now = new Date();
      const diff = now.getTime() - date.getTime();
      const minutes = Math.floor(diff / 60000);
      const hours = Math.floor(minutes / 60);
      const days = Math.floor(hours / 24);

      if (minutes < 1) return t('history.justNow') || 'Just now';
      if (minutes < 60) return `${minutes}m ago`;
      if (hours < 24) return `${hours}h ago`;
      if (days < 7) return `${days}d ago`;
      return formatTime(timestamp);
    } catch {
      return timestamp;
    }
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const handleClearAll = async () => {
    if (!confirm(t('history.confirmClearAll') || 'Are you sure you want to clear all history?')) return;

    setIsClearing(true);
    try {
      const success = await api.history.clearAll();
      if (success) {
        setBackups([]);
      } else {
        alert(t('history.clearFailed') || 'Failed to clear history');
      }
    } catch (error) {
      console.error('Failed to clear history:', error);
      alert(t('history.clearFailed') || 'Failed to clear history');
    } finally {
      setIsClearing(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full bg-[var(--color-bg)]">
        <div className="w-8 h-8 border-2 border-[var(--color-border)] border-t-[#0a84ff] rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-[var(--color-bg)]">
      {/* 头部 */}
      <div className={`flex items-center justify-between px-4 py-2 drag-region relative border-b border-[var(--color-border)] ${isMac ? 'pl-20' : 'pr-[140px]'}`}>
        <div className="flex items-center gap-4">
          <h1 className="text-[15px] font-semibold text-[var(--color-text)]">
            {t('history.title')}
          </h1>
          <span className="text-[12px] text-[var(--color-muted2)]">
            {backups.length} {t('history.backups') || 'backups'}
          </span>
        </div>

        <div className="flex items-center gap-2 no-drag">
          {backups.length > 0 && (
            <button
              onClick={handleClearAll}
              disabled={isClearing}
              className="px-2.5 py-1 rounded text-[12px] text-[#ff3b30] hover:bg-[#ff3b30]/10 transition-colors disabled:opacity-50"
            >
              {isClearing ? t('history.clearing') || 'Clearing...' : t('history.clearAll') || 'Clear All'}
            </button>
          )}
          <button
            onClick={() => loadBackups(true)}
            className="p-1.5 rounded text-[var(--color-muted2)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-hover)] transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
            </svg>
          </button>
        </div>
        <WindowControls />
      </div>

      {/* 内容 */}
      <div className="flex-1 overflow-y-auto">
        {backups.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full">
            <div className="w-12 h-12 rounded-full bg-[var(--color-surface-hover)] flex items-center justify-center mb-3">
              <svg className="w-6 h-6 text-[var(--color-muted)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <p className="text-[13px] text-[var(--color-text)] mb-1">{t('history.empty')}</p>
            <p className="text-[12px] text-[var(--color-muted)]">{t('history.emptyHint')}</p>
          </div>
        ) : (
          <div className="p-4">
            <div className="card overflow-hidden">
              {backups.map((backup, index) => (
                <div
                  key={backup.timestamp}
                  className={`
                    flex items-center gap-3 px-4 py-3
                    ${index !== backups.length - 1 ? 'border-b border-[var(--color-border)]' : ''}
                  `}
                >
                  {/* 内容 */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] font-medium text-[var(--color-text)]">
                        {formatTime(backup.timestamp)}
                      </span>
                      <span className="text-[12px] text-[var(--color-muted)]">
                        {formatRelativeTime(backup.timestamp)}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-[12px] text-[var(--color-muted2)]">
                        {backup.serverCount} {t('history.servers')}
                      </span>
                      {/* 恒显示（含 0）：此前仅在 >0 时渲染，为 0 时整段消失，易被误读为「没统计 Skill」 */}
                      <span className="text-[12px] text-[var(--color-muted)]">•</span>
                      <span className="text-[12px] text-[var(--color-muted2)]">
                        {backup.skillCount || 0} {t('history.skills') || 'Skills'}
                      </span>
                      <span className="text-[12px] text-[var(--color-muted)]">•</span>
                      <span className="text-[12px] text-[var(--color-muted)]">
                        {formatSize(backup.size)}
                      </span>
                      {backup.clients && backup.clients.length > 0 && (
                        <>
                          <span className="text-[12px] text-[var(--color-muted)]">•</span>
                          <span className="text-[12px] text-[var(--color-muted)] flex items-center gap-1"
                                title={backup.clients.join(', ')}>
                            {backup.clients.slice(0, MAX_CLIENT_ICONS).map(c => (
                              <ClientIcon key={c} clientId={c} size={12} />
                            ))}
                            {backup.clients.length > MAX_CLIENT_ICONS && (
                              <span className="text-[12px] text-[var(--color-muted2)]">
                                +{backup.clients.length - MAX_CLIENT_ICONS}
                              </span>
                            )}
                          </span>
                        </>
                      )}
                    </div>
                  </div>

                  {/* 操作按钮 */}
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button
                      onClick={() => handleViewDiff(backup.timestamp)}
                      className="px-2.5 py-1 rounded text-[12px] text-[var(--color-muted2)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-hover)] transition-colors"
                    >
                      {t('history.view')}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 差异查看模态框 */}
      <Modal
        isOpen={!!selectedDiff}
        onClose={() => setSelectedDiff(null)}
        title={t('history.view')}
        size="lg"
      >
        {selectedDiff && (
          <div className="space-y-4">
            {/* MCP Servers 变更统计 */}
            <div>
              <p className="text-[12px] text-[var(--color-muted)] mb-2">MCP Servers</p>
              <div className="flex gap-2 flex-wrap">
                {selectedDiff.added.length > 0 && (
                  <span className="tag tag-success">
                    +{selectedDiff.added.length} {t('history.added')}
                  </span>
                )}
                {selectedDiff.removed.length > 0 && (
                  <span className="px-2 py-0.5 rounded text-[12px] bg-[#ff3b30]/15 text-[#ff3b30]">
                    -{selectedDiff.removed.length} {t('history.removed')}
                  </span>
                )}
                {selectedDiff.modified.length > 0 && (
                  <span className="tag tag-warning">
                    ~{selectedDiff.modified.length} {t('history.modified')}
                  </span>
                )}
                {selectedDiff.added.length === 0 && 
                 selectedDiff.removed.length === 0 && 
                 selectedDiff.modified.length === 0 && (
                  <span className="text-[12px] text-[var(--color-muted)]">
                    {t('history.noChanges')}
                  </span>
                )}
              </div>
            </div>

            {/* Skills 变更统计 */}
            {((selectedDiff.skillsAdded?.length || 0) > 0 || (selectedDiff.skillsRemoved?.length || 0) > 0 || (selectedDiff.skillsModified?.length || 0) > 0) && (
              <div>
                <p className="text-[12px] text-[var(--color-muted)] mb-2">Skills</p>
                <div className="flex gap-2 flex-wrap">
                  {(selectedDiff.skillsAdded?.length || 0) > 0 && (
                    <span className="tag tag-success">
                      +{selectedDiff.skillsAdded.length} {t('history.added')}
                    </span>
                  )}
                  {(selectedDiff.skillsRemoved?.length || 0) > 0 && (
                    <span className="px-2 py-0.5 rounded text-[12px] bg-[#ff3b30]/15 text-[#ff3b30]">
                      -{selectedDiff.skillsRemoved.length} {t('history.removed')}
                    </span>
                  )}
                  {(selectedDiff.skillsModified?.length || 0) > 0 && (
                    <span className="tag tag-warning">
                      ~{selectedDiff.skillsModified.length} {t('history.modified')}
                    </span>
                  )}
                </div>
              </div>
            )}

            {/* MCP Servers 变更详情（按客户端展示，识别「从多客户端之一移除」等单客户端变更） */}
            {(selectedDiff.added.length > 0 || selectedDiff.removed.length > 0 || selectedDiff.modified.length > 0) && (
              selectedDiff.clientChanges && selectedDiff.clientChanges.length > 0 ? (
                <div className="space-y-2 max-h-60 overflow-y-auto">
                  {selectedDiff.clientChanges.map((cc) => (
                    <div key={cc.client} className="rounded-md border border-[var(--color-border)] p-2">
                      <div className="flex items-center gap-1.5 mb-1.5 text-[12px] text-[var(--color-muted2)]">
                        <ClientIcon clientId={cc.client} size={14} />
                        <span className="font-medium">{cc.client}</span>
                      </div>
                      <div className="flex flex-col gap-1">
                        {cc.added.map((id) => (
                          <DiffChangeRow key={`a-${id}`} id={id} kind="added" label="Server" />
                        ))}
                        {cc.removed.map((id) => (
                          <DiffChangeRow key={`r-${id}`} id={id} kind="removed" label="Server" />
                        ))}
                        {cc.modified.map((id) => (
                          <DiffChangeRow key={`m-${id}`} id={id} kind="modified" label="Server" />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="space-y-1.5 max-h-40 overflow-y-auto">
                  {selectedDiff.added.map((id) => (
                    <DiffChangeRow key={id} id={id} kind="added" label="Server" />
                  ))}
                  {selectedDiff.removed.map((id) => (
                    <DiffChangeRow key={id} id={id} kind="removed" label="Server" />
                  ))}
                  {selectedDiff.modified.map((id) => (
                    <DiffChangeRow key={id} id={id} kind="modified" label="Server" />
                  ))}
                </div>
              )
            )}

            {/* Skills 变更详情（按客户端展示） */}
            {((selectedDiff.skillsAdded?.length || 0) > 0 || (selectedDiff.skillsRemoved?.length || 0) > 0 || (selectedDiff.skillsModified?.length || 0) > 0) && (
              selectedDiff.skillClientChanges && selectedDiff.skillClientChanges.length > 0 ? (
                <div className="space-y-2 max-h-60 overflow-y-auto">
                  {selectedDiff.skillClientChanges.map((cc) => (
                    <div key={cc.client} className="rounded-md border border-[var(--color-border)] p-2">
                      <div className="flex items-center gap-1.5 mb-1.5 text-[12px] text-[var(--color-muted2)]">
                        <ClientIcon clientId={cc.client} size={14} />
                        <span className="font-medium">{cc.client}</span>
                      </div>
                      <div className="flex flex-col gap-1">
                        {cc.added.map((name) => (
                          <DiffChangeRow key={`a-${name}`} id={name} kind="added" label="Skill" />
                        ))}
                        {(cc.modified || []).map((name) => (
                          <DiffChangeRow key={`m-${name}`} id={name} kind="modified" label="Skill" />
                        ))}
                        {cc.removed.map((name) => (
                          <DiffChangeRow key={`r-${name}`} id={name} kind="removed" label="Skill" />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="space-y-1.5 max-h-40 overflow-y-auto">
                  {selectedDiff.skillsAdded?.map((name) => (
                    <DiffChangeRow key={name} id={name} kind="added" label="Skill" />
                  ))}
                  {selectedDiff.skillsModified?.map((name) => (
                    <DiffChangeRow key={name} id={name} kind="modified" label="Skill" />
                  ))}
                  {selectedDiff.skillsRemoved?.map((name) => (
                    <DiffChangeRow key={name} id={name} kind="removed" label="Skill" />
                  ))}
                </div>
              )
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
