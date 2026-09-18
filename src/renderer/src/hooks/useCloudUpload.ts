import {useState} from 'react';
import {useTranslation} from 'react-i18next';
import type {InstalledSkill, SkillClientType, SkillCloudConflict} from '../lib/electron';
import {useElectronAPI} from '../lib/electron';
import type {InstalledServer} from '../pages/Library';
import {toast} from '../components/Toast';

export interface CloudUploadController {
    cloudBusy: 'push' | 'pull' | null;
    cloudUploadConfirmOpen: boolean;
    cloudConflictOpen: boolean;
    cloudConflicts: SkillCloudConflict[];
    conflictResolutions: Record<string, 'overwrite' | 'skip'>;
    /** MCP 上传前的「完整覆盖云端」确认（plan-3.0）：云端已有同名 server 时提示 */
    mcpOverwriteConfirm: { total: number; existing: number } | null;
    setCloudUploadConfirmOpen: (v: boolean) => void;
    setCloudConflictOpen: (v: boolean) => void;
    setConflictResolutions: (v: Record<string, 'overwrite' | 'skip'>) => void;
    setMcpOverwriteConfirm: (v: { total: number; existing: number } | null) => void;
    pushCloudAsync: (scope: 'mcp' | 'skills') => void;
    autoPushIfCloud: (targets: string[], scope: 'mcp' | 'skills') => Promise<void>;
    handleCloudUpload: () => void;
    confirmCloudUpload: () => void;
    toggleConflictResolution: (skillName: string) => void;
    doCloudUploadResolved: () => Promise<void>;
    confirmMcpOverwrite: () => void;
}

/**
 * 云上传 / 云同步逻辑（P2-2）。
 * 原 Library 中云上传确认、冲突检测与后台推送相关的一批 useState / 处理函数统一收拢到此处，
 * 返回 Library 渲染与事件绑定所需的全部状态与回调。本 hook 不引入任何新的全局状态。
 */
export function useCloudUpload(params: {
    activeTab: 'mcp' | 'skills';
    servers: InstalledServer[];
    skills: InstalledSkill[];
    skillClients: Record<string, SkillClientType[]>;
    loadData: () => Promise<void>;
}): CloudUploadController {
    const {activeTab, servers, skills, skillClients, loadData} = params;
    const {t} = useTranslation();
    const api = useElectronAPI();

    const [cloudBusy, setCloudBusy] = useState<'push' | 'pull' | null>(null);
    const [cloudUploadConfirmOpen, setCloudUploadConfirmOpen] = useState(false);
    const [cloudConflictOpen, setCloudConflictOpen] = useState(false);
    const [cloudConflicts, setCloudConflicts] = useState<SkillCloudConflict[]>([]);
    const [conflictResolutions, setConflictResolutions] = useState<Record<string, 'overwrite' | 'skip'>>({});
    const [mcpOverwriteConfirm, setMcpOverwriteConfirm] = useState<{ total: number; existing: number } | null>(null);

    /**
     * 后台异步把暂存区推到云端（不阻塞当前操作界面）。
     */
    const pushCloudAsync = (scope: 'mcp' | 'skills') => {
        if (!api.syncTasks) {
            // 兜底：极少数情况下接口不可用，退回直接推送
            void api.cloudSync.push().then((res) => {
                if (res.ok) toast.success(res.message || t('library.uploadedToCloud'));
                else toast.error(res.message || t('library.uploadCloudFailed'));
            }).catch((err) => {
                toast.error(err?.message || t('library.uploadCloudFailed'));
            });
            return;
        }
        const title = scope === 'mcp'
            ? (t('syncTasks.pushMcpTitle') || '上传 MCP 配置到云端')
            : (t('syncTasks.pushSkillsTitle') || '上传技能到云端');
        void api.syncTasks.enqueue('cloud-push', title, scope).then(() => {
            toast.info(t('library.cloudEnqueued') || '已加入后台同步队列，可在左侧「同步任务」查看');
        }).catch((err) => {
            toast.error(err?.message || t('library.syncEnqueueFailed'));
        });
    };

    /**
     * 同步目标包含云端时，把暂存区推到远端（异步，不卡界面）。
     */
    const autoPushIfCloud = async (targets: string[], scope: 'mcp' | 'skills') => {
        if (!targets.includes('cloud')) return;
        pushCloudAsync(scope);
    };

    // 云上传：按当前 Tab 只把对应类型（MCP 或 Skill）写入云端暂存区，远端传输异步进行。
    const doCloudUpload = async () => {
        setCloudBusy('push');
        try {
            if (activeTab === 'mcp') {
                // 上传方向防护（plan-3.0）：云端已有 server 配置时弹「完整覆盖」确认。
                // MCP 无可靠的 per-server 时间戳，按用户语义不比新旧、只问覆盖与否
                //（差异明细可先在「我的库」顶部一致性 banner 中对照查看）。
                if (servers.length > 0) {
                    const cloudServers = await api.config.getServers('cloud').catch(() => ({} as Record<string, unknown>));
                    const cloudNames = new Set(Object.keys(cloudServers || {}));
                    if (cloudNames.size > 0) {
                        const existing = servers.filter(s => cloudNames.has(s.id)).length;
                        setMcpOverwriteConfirm({total: servers.length, existing});
                        setCloudBusy(null);
                        return; // 确认后由 confirmMcpOverwrite 继续
                    }
                }
                await doMcpUpload();
            } else {
                const skillItems = skills
                    .map(s => ({
                        name: s.name,
                        sourceClient: (skillClients[s.name] || []).find(c => c !== 'cloud') as SkillClientType
                    }))
                    .filter(i => i.sourceClient);
                if (skillItems.length === 0) {
                    setCloudBusy(null);
                    return;
                }
                // 检测云端同名冲突
                const conflicts = await api.skills.checkCloudConflicts(skillItems);
                if (conflicts.length > 0) {
                    // 有冲突：弹窗让用户确认
                    setCloudConflicts(conflicts);
                    // 默认全部覆盖
                    const defaultResolutions: Record<string, 'overwrite' | 'skip'> = {};
                    for (const c of conflicts) {
                        defaultResolutions[c.name] = 'overwrite';
                    }
                    setConflictResolutions(defaultResolutions);
                    setCloudConflictOpen(true);
                    setCloudBusy(null);
                    return;
                }
                // 无冲突：直接同步
                await api.skills.syncBatch(skillItems, ['cloud']);
                await loadData();
                toast.success(t('library.cloudUploadStarted') || '云端上传中…');
                pushCloudAsync('skills');
            }
        } catch (error: any) {
            console.error('Cloud upload failed:', error);
            toast.error(error?.message || t('library.cloudUploadFailed'));
        } finally {
            setCloudBusy(null);
        }
    };

    /** MCP 实际写入云端暂存区 + 后台推送（与「完整覆盖」确认解耦后的执行体） */
    const doMcpUpload = async () => {
        if (servers.length > 0) {
            await api.config.syncServersBatch(
                servers.map(s => ({serverId: s.id, config: s.config})),
                ['cloud']
            );
        }
        // 本地暂存区已就绪，立即刷新界面，远端推送在后台异步完成
        await loadData();
        toast.success(t('library.cloudUploadStarted') || '云端上传中…');
        pushCloudAsync('mcp');
    };

    /** MCP「完整覆盖云端」确认：继续执行上传 */
    const confirmMcpOverwrite = () => {
        setMcpOverwriteConfirm(null);
        setCloudBusy('push');
        doMcpUpload().catch((error: any) => {
            console.error('Cloud upload failed:', error);
            toast.error(error?.message || t('library.cloudUploadFailed'));
        }).finally(() => setCloudBusy(null));
    };

    // 按用户确认结果同步 Skill 到云端
    const doCloudUploadResolved = async () => {
        setCloudConflictOpen(false);
        setCloudBusy('push');
        try {
            const skillItems = skills
                .map(s => ({
                    name: s.name,
                    sourceClient: (skillClients[s.name] || []).find(c => c !== 'cloud') as SkillClientType
                }))
                .filter(i => i.sourceClient);
            if (skillItems.length > 0) {
                await api.skills.syncToCloudResolved(skillItems, conflictResolutions);
            }
            await loadData();
            toast.success(t('library.cloudUploadStarted') || '云端上传中…');
            pushCloudAsync('skills');
        } catch (error: any) {
            console.error('Cloud upload failed:', error);
            toast.error(error?.message || t('library.cloudUploadFailed'));
        } finally {
            setCloudBusy(null);
        }
    };

    // 切换冲突项的覆盖/跳过
    const toggleConflictResolution = (skillName: string) => {
        setConflictResolutions(prev => ({
            ...prev,
            [skillName]: prev[skillName] === 'overwrite' ? 'skip' : 'overwrite',
        }));
    };

    // 顶部「云上传」入口：先确认是否覆盖云端，再全量上传
    const handleCloudUpload = () => {
        setCloudUploadConfirmOpen(true);
    };

    const confirmCloudUpload = () => {
        setCloudUploadConfirmOpen(false);
        void doCloudUpload();
    };

    return {
        cloudBusy,
        cloudUploadConfirmOpen,
        cloudConflictOpen,
        cloudConflicts,
        conflictResolutions,
        mcpOverwriteConfirm,
        setCloudUploadConfirmOpen,
        setCloudConflictOpen,
        setConflictResolutions,
        setMcpOverwriteConfirm,
        pushCloudAsync,
        autoPushIfCloud,
        handleCloudUpload,
        confirmCloudUpload,
        toggleConflictResolution,
        doCloudUploadResolved,
        confirmMcpOverwrite,
    };
}
