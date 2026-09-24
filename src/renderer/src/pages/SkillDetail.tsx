/**
 * Skill 详情页面
 * 支持两种数据源：远程 Registry 和本地已安装 Skill
 */

import {useCallback, useEffect, useMemo, useState} from 'react';
import {useNavigate, useParams, useSearchParams} from 'react-router-dom';
import {useQuery} from '@tanstack/react-query';
import {useTranslation} from 'react-i18next';
import {
    type ClientInfo,
    type DiscoveredSkill,
    type LocalSkillDetail,
    type SkillClientType,
    useElectronAPI
} from '../lib/electron';
import {useIsMac} from '../lib/useIsMac';
import {pickSkillDescription} from '../lib/localizedText';
import {parseFrontmatter} from '../../../shared/frontmatter';
import ClientIcon from '../components/ClientIcon';
import ClientMultiSelect from '../components/ClientMultiSelect';
import Modal from '../components/Modal';
import {toast} from '../components/Toast';
import {PLATFORM_SKILL_DOWNLOAD, type PlatformType} from '../../../shared/platform-constants';
import {ClockIcon, DownloadIcon, EyeIcon, ForkIcon, StarIcon} from '../components/Icons';
import WindowControls from '../components/WindowControls';
import {localizeCategoryList, translateCategoryName} from '../lib/categoryAlias';
import {useStore} from '../store/useStore';
import {buildInstalledSkillKeys, isSkillInstalled, skillItemKeys} from '../../../shared/skill-identity';
import {deriveSkillMdRawUrl} from '../lib/skillMdUrl';

function formatNumber(count: number): string {
    if (count >= 1000000) return `${(count / 1000000).toFixed(1)}M`;
    if (count >= 1000) return `${(count / 1000).toFixed(1)}K`;
    return count.toString();
}

function formatDate(dateStr: string): string {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', {year: 'numeric', month: 'short', day: 'numeric'});
}

function SkillAvatar({author, size = 48}: { author: string; size?: number }) {
    const [avatarError, setAvatarError] = useState(false);
    const avatarUrl = `https://avatars.githubusercontent.com/${author}`;
    const initial = author.charAt(0).toUpperCase();
    const colors = ['bg-blue-500', 'bg-purple-500', 'bg-green-500', 'bg-orange-500', 'bg-pink-500', 'bg-cyan-500'];
    const colorIndex = author.charCodeAt(0) % colors.length;

    if (!avatarError) {
        return (
            <img src={avatarUrl} alt={author} className="rounded-xl object-cover"
                 style={{width: size, height: size}} onError={() => setAvatarError(true)}/>
        );
    }
    // 彩色底上首字母固定用白色，浅色主题下 text 令牌会变深色、压在彩底上不可读
    return (
        <div className={`rounded-xl ${colors[colorIndex]} flex items-center justify-center text-white font-bold`}
             style={{width: size, height: size, fontSize: size * 0.4}}>
            {initial}
        </div>
    );
}

// 统一的 Skill 数据视图（兼容 registry 和 local）
// 简介不入库：它依赖界面语言，统一在渲染期由 skillMdContent + 列表元数据现算（见 description）
interface SkillView {
    type: 'registry' | 'local';
    name: string;
    author: string;
    categoryId?: string;
    category?: string;
    /** 完整分类标签（透传源多分类，如虾评）；缺省时详情仅展示主分类 */
    categories?: string[];
    stars?: number;
    forks?: number;
    /** 浏览量（ModelScope 列表字段 view_count） */
    viewCount?: number | null;
    /** 下载量（ModelScope 列表字段 downloads） */
    downloads?: number | null;
    updatedAt?: string;
    repositoryUrl?: string;
    branch?: string;
    skillPath?: string;
    skillMdContent: string;
    skillMdRawUrl?: string;
    files: Array<{ name: string; size?: string; path?: string }>;
    stats?: { totalFiles?: number; totalSize?: string; license?: string };
    skillMdLines?: number;
    installedClients: SkillClientType[];
}

interface SkillMeta {
    id?: string;
    name?: string;
    description?: string;
    /** 列表接口给出的显式语言变体（如 { zh: '…' }） */
    descriptions?: Record<string, string>;
    author?: string;
    categoryId?: string;
    category?: string;
    /** 完整分类标签（透传源多分类，如虾评） */
    categories?: string[];
    stars?: number;
    /** 浏览量（ModelScope view_count） */
    viewCount?: number | null;
    /** 下载量（ModelScope downloads） */
    downloads?: number | null;
    sourceUrl?: string | null;
}

export default function SkillDetail() {
    const {t, i18n} = useTranslation();
    const navigate = useNavigate();
    const {id} = useParams<{ id: string }>();
    const [searchParams] = useSearchParams();
    const api = useElectronAPI();
    const isMac = useIsMac();
    const setInstalledSkillIds = useStore(s => s.setInstalledSkillIds);

    // 安装/卸载成功后立即同步全局已安装集合：商店卡片的「已安装」徽章直接读它，
    // 仅靠「返回商店时组件重新挂载才拉取」会受路由挂载时机影响。
    const syncInstalledSkillIds = useCallback(() => {
        api.skills.getAllInstalled()
            .then(({skills}) => setInstalledSkillIds(Object.keys(skills)))
            .catch(() => {});
    }, [api, setInstalledSkillIds]);

    // 来自 API 直连来源的技能：conn=连接ID & src=源URL，走 resolveSkill 安装链路
    const connId = searchParams.get('conn');
    const srcUrl = searchParams.get('src');
    // 列表项携带的元数据包（SPA 站点如 SkillHub/ClawHub 无法解析为可安装 Skill 时，用于预览展示）
    // 必须 memo：meta 会进 useEffect / useMemo 依赖，每次渲染新建对象会让它们空转
    const rawMeta = searchParams.get('meta');
    const meta = useMemo<SkillMeta | null>(() => {
        if (!rawMeta) return null;
        try {
            return JSON.parse(decodeURIComponent(rawMeta)) as SkillMeta;
        } catch {
            return null;
        }
    }, [rawMeta]);

    const [clients, setClients] = useState<ClientInfo[]>([]);
    const [selectedClients, setSelectedClients] = useState<SkillClientType[]>([]);
    const [showInstallModal, setShowInstallModal] = useState(false);
    const [isInstalling, setIsInstalling] = useState(false);
    const [installedInClients, setInstalledInClients] = useState<SkillClientType[]>([]);
    const [skillView, setSkillView] = useState<SkillView | null>(null);
    const [isLoadingLocal, setIsLoadingLocal] = useState(false);
    // 直连解析得到的 DiscoveredSkill（用于 installFromDiscovered）
    const [resolvedSkill, setResolvedSkill] = useState<DiscoveredSkill | null>(null);
    /** 当前连接（connId）所属的平台类型，决定该源是否具备下载安装通道 */
    const [connPlatform, setConnPlatform] = useState<PlatformType | null>(null);

    const decodedId = id ? decodeURIComponent(id) : '';

    // 直连来源：解析为可安装 Skill（跳过 registry / 本地）
    const {data: resolved, isLoading: isResolving} = useQuery({
        queryKey: ['skillResolve', connId, srcUrl],
        queryFn: async () => {
            if (!connId || !srcUrl) return null;
            const res = await api.apiConnections.resolveSkill(connId, srcUrl);
            if (res && res.success && res.skills && res.skills.length > 0) {
                // 解析出多个 skill（仓库根 URL 场景）：按当前 id 末段 / 卡片名匹配具体 skill，
                // 避免盲取 skills[0] 装错 skill 子目录（下载地址不对）。
                if (res.skills.length > 1) {
                    const key = decodedId.split('/').pop()?.toLowerCase() || '';
                    const matched = res.skills.find(
                        (s: DiscoveredSkill) =>
                            (s.path && s.path.split('/').pop()?.toLowerCase() === key) ||
                            s.name.toLowerCase() === key
                    );
                    if (matched) return matched as DiscoveredSkill;
                }
                return res.skills[0] as DiscoveredSkill;
            }
            return null;
        },
        enabled: !!connId && !!srcUrl,
        retry: false,
    });

    useEffect(() => {
        if (resolved) {
            setResolvedSkill(resolved);
            setSkillView({
                type: 'registry',
                name: resolved.name,
                author: resolved.repository.owner,
                categoryId: undefined,
                category: undefined,
                stars: undefined,
                forks: undefined,
                viewCount: meta?.viewCount ?? null,
                downloads: meta?.downloads ?? null,
                updatedAt: undefined,
                repositoryUrl: resolved.repository.url,
                branch: resolved.repository.branch,
                skillPath: resolved.path,
                skillMdContent: resolved.skillMdContent || '',
                skillMdRawUrl: resolved.skillMdUrl || undefined,
                files: resolved.files.map(f => ({name: f.name, path: f.path})),
                installedClients: [],
            });
        }
    }, [resolved]);

    // 从远程 GitHub Registry 获取详情（复用解析通道；直连来源不走此路）
    const {data: remoteDetail, isLoading: isLoadingRegistry, error: registryError} = useQuery({
        queryKey: ['skillRemoteDetail', decodedId],
        queryFn: async () => {
            const res = await api.skills.getRemoteDetail(decodedId);
            if (res && res.success && res.skill) return res.skill as DiscoveredSkill;
            return null;
        },
        enabled: !!decodedId && !connId,
        retry: false,
    });

    // 远程解析成功 → 构建 SkillView（与直连 resolve 分支共用同一结构，安装走 installFromDiscovered）
    useEffect(() => {
        if (remoteDetail) {
            setResolvedSkill(remoteDetail);
            setSkillView({
                type: 'registry',
                name: remoteDetail.name,
                author: remoteDetail.repository.owner,
                categoryId: undefined,
                category: undefined,
                stars: undefined,
                forks: undefined,
                viewCount: meta?.viewCount ?? null,
                downloads: meta?.downloads ?? null,
                updatedAt: undefined,
                repositoryUrl: remoteDetail.repository.url,
                branch: remoteDetail.repository.branch,
                skillPath: remoteDetail.path,
                skillMdContent: remoteDetail.skillMdContent || '',
                skillMdRawUrl: remoteDetail.skillMdUrl || undefined,
                files: remoteDetail.files.map(f => ({name: f.name, path: f.path})),
                installedClients: [],
            });
        }
    }, [remoteDetail]);

    // 远程解析失败（或无匹配）→ fallback 到本地（直连来源不走此路）
    // 注意：getRemoteDetail 在找不到匹配时返回 {success:false} 而不抛异常，
    // 因此 registryError 为空，不能据此跳过本地兜底，否则本地已安装的 Skill 永远加载失败。
    useEffect(() => {
        if (connId) return;
        if (isLoadingRegistry || remoteDetail) return;

        let cancelled = false;
        setIsLoadingLocal(true);

        api.skills.getLocalDetail(decodedId).then((local: LocalSkillDetail | null) => {
            if (cancelled) return;
            setIsLoadingLocal(false);

            if (!local) return;

            // .source.json 的 id 只有形如 owner/slug（GitHub / ClawHub）时才携带发布者；
            // 平台内部 id（虾评实测为 UUID）不含分隔符，取「首段」会把整串 id 当成作者名（plan-17.0）。
            const sourceId = local.source?.id ?? '';
            const owner = sourceId.includes('/') ? sourceId.split('/')[0] : '';
            setSkillView({
                type: 'local',
                name: local.name,
                author: owner,
                repositoryUrl: local.source?.source?.repositoryUrl,
                branch: local.source?.source?.branch,
                skillPath: local.source?.source?.skillPath,
                skillMdContent: local.skillMdContent,
                // 仅当 rawBaseUrl 非空时才给出外链：zip/平台压缩包通道的 skill 其 rawBaseUrl 恒为空串，
                // 直接拼接会产出 '/SKILL.md' 死链。派生逻辑收口在 deriveSkillMdRawUrl（可单测）。
                skillMdRawUrl: deriveSkillMdRawUrl(local.source?.source?.rawBaseUrl),
                files: local.files.map(f => ({name: f})),
                installedClients: local.clients,
            });
            setInstalledInClients(local.clients);
        }).catch(() => {
            if (!cancelled) setIsLoadingLocal(false);
        });

        return () => {
            cancelled = true;
        };
    }, [registryError, isLoadingRegistry, remoteDetail, decodedId, api]);

    // 列表项元数据包预览：当直连解析/远程详情都拿不到可安装 Skill（如 SkillHub/ClawHub 这类 SPA 站点
    // 没有可解析的 SKILL.md 下载通道）时，用列表项自带的元数据渲染一个只读预览页，保证详情页可进入且
    // 展示内容与列表一致，而不是硬报错。该预览无 SKILL.md 内容，安装不可用。
    useEffect(() => {
        if (skillView) return;
        if (resolved || remoteDetail) return; // 已通过正常通道获得数据
        if (!meta) return;
        setSkillView({
            type: 'registry',
            name: meta.name || decodedId,
            author: meta.author || '',
            categoryId: meta.categoryId,
            category: meta.category ?? meta.categoryId,
            categories: meta.categories,
            stars: meta.stars,
            forks: undefined,
            viewCount: meta.viewCount ?? null,
            downloads: meta.downloads ?? null,
            updatedAt: undefined,
            repositoryUrl: meta.sourceUrl || '',
            branch: '',
            skillPath: '',
            skillMdContent: '',
            skillMdRawUrl: undefined,
            files: [],
            installedClients: [],
        });
    }, [meta, resolved, remoteDetail, skillView, decodedId]);

    // 获取客户端列表
    useEffect(() => {
        api.clients.getAll().then(clientList => {
            const skillClients = clientList.filter(c => c.supportsSkills);
            setClients(skillClients);
            const firstInstalled = skillClients.find(c => c.installed);
            if (firstInstalled) {
                setSelectedClients([firstInstalled.id as SkillClientType]);
            }
        });
    }, [api]);

    // 平台源：查出连接所属平台，判断它是否实现下载通道（决定安装按钮可用性）
    useEffect(() => {
        if (!connId) {
            setConnPlatform(null);
            return;
        }
        api.apiConnections.list().then(list => {
            setConnPlatform((list.find(c => c.id === connId)?.platformType as PlatformType) ?? null);
        }).catch(() => setConnPlatform(null));
    }, [api, connId]);

    // 检查已安装状态（registry skill）
    useEffect(() => {
        if (skillView?.type !== 'registry') return;
        // 平台源的展示名（display_name）与落盘目录名不是同一个字符串，
        // 必须走与商店卡片一致的别名口径，否则详情页会一直显示「未安装」。
        const itemKeys = skillItemKeys({
            id: decodedId,
            name: skillView.name,
            sourceUrl: skillView.repositoryUrl,
        });
        api.skills.getAllInstalled().then(({byClient}) => {
            const installedIn: SkillClientType[] = [];
            for (const [client, skills] of Object.entries(byClient)) {
                const clientKeys = buildInstalledSkillKeys(skills.map(s => s.name));
                if (isSkillInstalled(clientKeys, itemKeys)) {
                    installedIn.push(client as SkillClientType);
                }
            }
            setInstalledInClients(installedIn);
        });
    }, [api, skillView, decodedId]);

    // 平台源是否提供下载安装通道（如虾评）。唯一事实源是适配器是否实现 fetchSkillDownload，
    // 渲染层无法直接 import 主进程适配器，故用 shared 常量镜像（由单测守卫同步）。
    const canInstallFromPlatform =
        !!connId && !!connPlatform && PLATFORM_SKILL_DOWNLOAD.includes(connPlatform);

    const handleInstall = async () => {
        if (!skillView) {
            toast.error(t('skill.invalidSkill') || 'Skill data is invalid, please reopen the detail page');
            return;
        }
        if (selectedClients.length === 0) {
            toast.error(t('skill.selectClientFirst') || 'Please select at least one client to install');
            return;
        }
        setIsInstalling(true);
        try {
            if (canInstallFromPlatform) {
                // 平台源（如虾评）：用连接绑定的令牌换下载直链，主进程走 zip 安装通道
                const result = await api.skills.installPlatformSkill(
                    connId!, decodedId, skillView.name, selectedClients
                );
                if (result && result.success === false) {
                    console.error('[SkillDetail] installPlatformSkill failed:', {
                        skillName: skillView.name,
                        connectionId: connId,
                        platform: connPlatform,
                        skillId: decodedId,
                        error: result.error,
                    });
                    throw new Error(result.error || (t('skill.installFailed') || 'Installation failed'));
                }
            } else if (resolvedSkill) {
                // 直连平台来源（带 connId）与 GitHub Registry 来源（resolvedSkill 已解析成功）
                // 统一走 resolveSkill → installFromDiscovered 通道
                const result = await api.skills.installFromDiscovered(resolvedSkill, selectedClients);
                if (result && result.success === false) {
                    // installFromDiscovered 失败时是返回 { success: false, error } 而非抛异常，必须显式检查
                    const detail = {
                        skillName: resolvedSkill.name,
                        sourceUrl: resolvedSkill.repository?.url,
                        downloadUrl: resolvedSkill.downloadUrl,
                        clients: selectedClients,
                        error: result.error,
                    };
                    console.error('[SkillDetail] installFromDiscovered failed:', detail);
                    throw new Error(result.error || (t('skill.installFailed') || 'Installation failed'));
                }
            } else {
                // 无已解析 Skill（直连源解析落空或 GitHub 源远程详情缺失）：尽力尝试远程详情回退，
                // 再按预览态元数据发起安装。预览态的文件清单为空，主进程会直接判失败，
                // 故此处必须校验返回值——install 失败是返回 { success: false } 而非抛异常。
                if (!connId && decodedId) {
                    // 只把「远程详情获取」包进 try：安装结果若也在这里，其失败会被 catch 吞掉
                    // 而继续走下方预览态兜底，用户看到的是「文件清单为空」而非真实安装错误。
                    let remote: DiscoveredSkill | null = null;
                    try {
                        const res = await api.skills.getRemoteDetail(decodedId);
                        if (res && res.success && res.skill) remote = res.skill as DiscoveredSkill;
                    } catch {
                        remote = null; // 远程详情获取失败 → 继续走下方预览态安装路径
                    }

                    if (remote) {
                        const result = await api.skills.installFromDiscovered(remote, selectedClients);
                        if (result && result.success === false) {
                            throw new Error(result.error || (t('skill.installFailed') || 'Installation failed'));
                        }
                        setShowInstallModal(false);
                        setInstalledInClients(prev => [...new Set([...prev, ...selectedClients])]);
                        syncInstalledSkillIds();
                        toast.success(t('skill.installSuccess') || 'Skill installed successfully');
                        return;
                    }
                }

                const repoUrl = skillView.repositoryUrl || '';
                const branch = skillView.branch || 'main';
                const skillPath = skillView.skillPath || '';
                const rawBaseUrl = skillView.skillMdRawUrl
                    ? skillView.skillMdRawUrl.replace('/SKILL.md', '')
                    : `https://raw.githubusercontent.com/${skillView.author}/${decodedId.split('/')[1] || skillView.name}/${branch}${skillPath ? `/${skillPath}` : ''}`;

                const fileNames = skillView.files?.map(f => f.name) || [];
                const sourceInfo = {
                    id: decodedId,
                    installedAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                    source: {repositoryUrl: repoUrl, branch, skillPath, rawBaseUrl},
                    files: fileNames,
                };
                const installResult = await api.skills.install(decodedId, sourceInfo, selectedClients);
                if (installResult && installResult.success === false) {
                    const detail = {
                        skillName: decodedId,
                        repositoryUrl: repoUrl,
                        rawBaseUrl,
                        fileCount: fileNames.length,
                        error: installResult.error,
                    };
                    console.error('[SkillDetail] install failed:', detail);
                    throw new Error(installResult.error || (t('skill.installFailed') || 'Installation failed'));
                }
            }
            setShowInstallModal(false);
            setInstalledInClients(prev => [...new Set([...prev, ...selectedClients])]);
            syncInstalledSkillIds();
            toast.success(t('skill.installSuccess') || 'Skill installed successfully');
        } catch (error) {
            console.error('[SkillDetail] install skill failed:', {
                decodedId,
                resolved: !!resolvedSkill,
                sourceUrl: resolvedSkill?.repository?.url,
                downloadUrl: resolvedSkill?.downloadUrl,
                clients: selectedClients,
                error,
            });
            toast.error((error as Error)?.message || (t('skill.installFailed') || 'Installation failed, please try again'));
        } finally {
            setIsInstalling(false);
        }
    };

    const openInstallModal = () => {
        const firstInstalled = clients.find(c => c.installed && !installedInClients.includes(c.id as SkillClientType));
        setSelectedClients(firstInstalled ? [firstInstalled.id as SkillClientType] : []);
        setShowInstallModal(true);
    };

    const handleUninstall = async () => {
        if (!skillView || installedInClients.length === 0) return;
        if (!confirm(t('skill.confirmUninstall') || 'Are you sure you want to uninstall this skill from all clients?')) return;
        const targets = installedInClients;
        try {
            await api.skills.uninstall(skillView.name, targets);
            setInstalledInClients([]);
            syncInstalledSkillIds();
            // 卸载目标含云端存储：本地暂存区已删除，需在后台把 skills 范围的变更推送到远端，
            // 否则云端仍残留该 Skill 目录（补齐此前卸载未触发云端同步的缺口）。
            if (targets.includes('cloud')) {
                const title = t('syncTasks.pushSkillsTitle') || '上传技能到云端';
                if (api.syncTasks) {
                    void api.syncTasks.enqueue('cloud-push', title, 'skills').then(() => {
                        toast.info(t('library.cloudEnqueued') || '已加入后台同步队列，可在左侧「同步任务」查看');
                    }).catch((err) => {
                        toast.error(err?.message || t('library.syncEnqueueFailed'));
                    });
                } else {
                    void api.cloudSync.push().then((res) => {
                        if (res.ok) toast.success(res.message || t('library.uploadedToCloud'));
                        else toast.error(res.message || t('library.uploadCloudFailed'));
                    }).catch((err) => {
                        toast.error(err?.message || t('library.uploadCloudFailed'));
                    });
                }
            }
        } catch (error) {
            console.error('Failed to uninstall skill:', error);
            toast.error(t('library.uninstallSkillFailed'));
        }
    };

    const toggleClient = (clientId: SkillClientType) => {
        setSelectedClients(prev =>
            prev.includes(clientId) ? prev.filter(c => c !== clientId) : [...prev, clientId]
        );
    };

    // 简介：SKILL.md frontmatter（技能自带的权威简介）+ 列表元数据一起参与择优。
    // 之所以放在渲染期算而不是写进 skillView：结果取决于界面语言，切换语言需要立即跟着变。
    const description = useMemo(
        () =>
            pickSkillDescription(i18n.language, {
                frontmatter: skillView?.skillMdContent ? parseFrontmatter(skillView.skillMdContent) : undefined,
                locales: meta?.descriptions,
                primary: meta?.description,
            }),
        [skillView?.skillMdContent, meta, i18n.language]
    );

    const isLoading = isLoadingRegistry || isLoadingLocal || isResolving;
    // 无可用安装通道：既不是可下载的平台源，也没解析出可安装的 Skill（即预览态）。
    // 此前该场景仍允许点击安装，会写出只含 .source.json 的空壳目录却提示成功（假成功）。
    // 加载完成前不判定，避免解析尚未返回就把按钮误置灰。
    const installBlocked = !isLoading && !canInstallFromPlatform && !resolvedSkill;

    if (isLoading && !skillView) {
        return (
            <div className="flex items-center justify-center h-full bg-[var(--color-bg)]">
                <div className="w-8 h-8 border-2 border-[var(--color-border)] border-t-[var(--color-accent)] rounded-full animate-spin"/>
            </div>
        );
    }

    if (!skillView) {
        return (
            <div className="flex flex-col items-center justify-center h-full bg-[var(--color-bg)]">
                <div className="w-12 h-12 rounded-full bg-[color-mix(in_srgb,var(--color-danger)_10%,transparent)] flex items-center justify-center mb-3">
                    <svg className="w-6 h-6 text-[var(--color-danger)]" fill="none" viewBox="0 0 24 24" stroke="currentColor"
                         strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round"
                              d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"/>
                    </svg>
                </div>
                <p className="text-[13px] text-[var(--color-muted2)] mb-3">{t('skill.loadFailed') || 'Failed to load skill'}</p>
                <button onClick={() => navigate(-1)} className="btn btn-secondary text-[13px]">
                    {t('detail.back')}
                </button>
            </div>
        );
    }

    const isInstalled = installedInClients.length > 0;
    const hasCategory = !!skillView.categoryId;
    // 分类展示名：优先用 locale 中 slug 的翻译（registry 源），否则回退到列表/详情提供的友好名（如 ModelScope 的中文名），最后回退原 slug。
    // 注意：不能用 `t('category.' + id) || fallback`，因为 i18next 在 key 缺失时返回 key 本身（truthy），兜底永远不生效。
    // 分类展示名：在统一的 `category.*` 命名空间查译文；
    // 未命中时回退详情/列表提供的友好名（如 ModelScope 的中文名），最后才是原 id。
    const catId = skillView.categoryId ?? '';
    const catTranslated = hasCategory ? translateCategoryName(catId, t, i18n) : '';
    const catLabel = hasCategory ? (catTranslated === catId ? (skillView.category ?? catId) : catTranslated) : '';
    // 分类 tag 列表：rawCats 为原始 id，catLabels 为对应译文（本地化按同索引对应）
    const fromList = !!skillView.categories?.length;
    const rawCats = fromList ? skillView.categories! : (skillView.categoryId ? [skillView.categoryId] : []);
    const catLabels = localizeCategoryList(
        {categories: rawCats, categoryNames: !fromList && skillView.category ? [skillView.category] : []},
        t, i18n,
    );
    const skillDirUrl = skillView.repositoryUrl && skillView.branch && skillView.skillPath
        ? `${skillView.repositoryUrl}/tree/${skillView.branch}/${skillView.skillPath}`
        : skillView.repositoryUrl || '';

    return (
        <div className="flex flex-col h-full bg-[var(--color-bg)]">
            {/* 头部导航（一体化标题栏：mac 上兼作拖拽区并为交通灯留白） */}
            <div
                className={`flex items-center gap-2 px-4 h-[32px] drag-region relative border-b border-[var(--color-border)] bg-[var(--color-bg)] text-[12px] text-[var(--color-muted)] ${isMac ? 'ps-20' : 'pe-[140px]'}`}>
                <button onClick={() => navigate(-1)} className="no-drag hover:text-[var(--color-text)] transition-colors">
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5"/>
                    </svg>
                </button>
                {skillView.type === 'registry' ? (
                    <>
                        <span className="no-drag hover:text-[var(--color-text)] cursor-pointer"
                              onClick={() => navigate('/store')}>{t('nav.store')}</span>
                        <span>/</span>
                        {hasCategory && (
                            <>
                                <span
                                    className="hover:text-[var(--color-text)] cursor-pointer">{catLabel}</span>
                                <span>/</span>
                            </>
                        )}
                    </>
                ) : (
                    <>
                        <span className="no-drag hover:text-[var(--color-text)] cursor-pointer"
                              onClick={() => navigate('/library')}>{t('nav.library')}</span>
                        <span>/</span>
                    </>
                )}
                <span className="text-[var(--color-text)]">{skillView.name}</span>
                <WindowControls />
            </div>

            {/* 内容区域 */}
            <div className="flex-1 overflow-hidden flex">
                {/* 左侧主内容 */}
                <div className="flex-1 overflow-y-auto">
                    <div className="p-6">
                        <div className="mb-6">
                            <div className="flex items-start gap-4 mb-3">
                                <SkillAvatar author={skillView.author} size={48}/>
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 mb-1">
                                        <h1 className="text-2xl font-bold text-[var(--color-text)]">{skillView.name}</h1>
                                        {skillView.type === 'local' && (
                                            <span
                                                className="px-2 py-0.5 rounded text-[12px] font-medium bg-[color-mix(in_srgb,var(--color-success)_10%,transparent)] text-[var(--color-success)] border border-[color-mix(in_srgb,var(--color-success)_30%,transparent)]">
                        {t('detail.installed')}
                      </span>
                                        )}
                                    </div>
                                    {/* 平台源（如虾评）的本地元数据不含发布者：作者为空时整句隐藏，避免显示 "by @" */}
                                    {skillView.author && (
                                        <span className="text-[14px] text-[var(--color-muted)]">by @{skillView.author}</span>
                                    )}
                                </div>
                            </div>

                            <p className="text-[14px] text-[var(--color-muted2)] leading-relaxed mb-4 whitespace-pre-line">
                                {description || t('detail.noDescription')}
                            </p>

                            {hasCategory && (
                                <div className="flex flex-wrap gap-2">
                                    {/* 分类徽章配色全站统一走 accent 主题令牌（与列表卡片/ServerCard 一致） */}
                                    {catLabels.map(label => (
                                        <span key={label} title={label}
                                              className="inline-block px-2 py-1 rounded-md text-[12px] font-medium border bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)] text-[var(--color-accent)] border-[color-mix(in_srgb,var(--color-accent)_20%,transparent)]">
                                            {label}
                                        </span>
                                    ))}
                                </div>
                            )}

                            {(skillView.stars != null || skillView.forks != null || skillView.updatedAt || skillView.viewCount != null || skillView.downloads != null) && (
                                <div className="flex items-center gap-4 mt-4 text-[13px] text-[var(--color-muted2)] flex-wrap">
                                    {skillView.stars != null && (
                                        <span className="flex items-center gap-1">
                      <StarIcon className="w-4 h-4 text-yellow-400"/>
                                            {formatNumber(skillView.stars)} Stars
                    </span>
                                    )}
                                    {skillView.viewCount != null && skillView.viewCount > 0 && (
                                        <span className="flex items-center gap-1">
                      <EyeIcon className="w-4 h-4"/>
                                            {formatNumber(skillView.viewCount)} {t('detail.views') || 'views'}
                    </span>
                                    )}
                                    {skillView.downloads != null && skillView.downloads > 0 && (
                                        <span className="flex items-center gap-1">
                      <DownloadIcon className="w-4 h-4"/>
                                            {formatNumber(skillView.downloads)} {t('store.downloads') || 'downloads'}
                    </span>
                                    )}
                                    {skillView.forks != null && (
                                        <span className="flex items-center gap-1">
                      <ForkIcon className="w-4 h-4 text-[var(--color-muted)]"/>
                                            {formatNumber(skillView.forks)} Forks
                    </span>
                                    )}
                                    {skillView.updatedAt && (
                                        <span className="flex items-center gap-1">
                      <ClockIcon className="w-4 h-4 text-[var(--color-muted)]"/>
                      Updated {formatDate(skillView.updatedAt)}
                    </span>
                                    )}
                                </div>
                            )}
                        </div>

                        <h2 className="text-[15px] font-semibold text-[var(--color-text)] mb-4">SKILL.md</h2>
                        <div className="card p-4 overflow-x-auto">
                            {skillView.skillMdContent ? (
                                <pre
                                    className="text-[12px] text-[var(--color-text)] font-mono leading-relaxed whitespace-pre-wrap">
                  <code>{skillView.skillMdContent}</code>
                </pre>
                            ) : (
                                <p className="text-[13px] text-[var(--color-muted)] italic">{t('detail.noReadme')}</p>
                            )}
                        </div>
                    </div>
                </div>

                {/* 右侧边栏 */}
                <div className="w-[280px] flex-shrink-0 border-s border-[var(--color-border)] overflow-y-auto p-4">
                    {/* 安装/卸载按钮 */}
                    <div className="mb-4">
                        {isInstalled ? (
                            <button onClick={handleUninstall} className="w-full btn btn-danger text-[13px]">
                                {t('detail.uninstallAll')}
                            </button>
                        ) : (
                            <button
                                onClick={openInstallModal}
                                disabled={installBlocked}
                                title={installBlocked ? (t('skill.installUnavailable') || '该来源不支持安装') : undefined}
                                className="w-full btn btn-primary text-[13px] disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {t('detail.install')}
                            </button>
                        )}

                        {/* 不可安装提示：既无下载通道也未解析出可安装 Skill（如 SkillHub/ClawHub 等 SPA 站点）。
                此前这类来源仍保持按钮可点，安装会产出只含 .source.json 的空壳目录并提示成功，故改为禁用。 */}
                        {installBlocked && !isInstalled && (
                            <div className="mt-2 space-y-2">
                                <p className="text-[12px] leading-relaxed text-[var(--color-muted2)] bg-[var(--color-surface)] rounded-md px-2.5 py-2">
                                    {t('skill.previewOnlyHint') || '该来源暂未提供可安装的 Skill 内容（无 SKILL.md 下载通道），仅支持预览。'}
                                </p>
                                {(meta?.sourceUrl || skillView?.repositoryUrl) && (
                                    <a
                                        href={meta?.sourceUrl || skillView?.repositoryUrl}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="block text-center text-[12px] text-[var(--color-accent)] hover:underline"
                                    >
                                        {t('skill.viewOriginal') || '查看原页面 →'}
                                    </a>
                                )}
                            </div>
                        )}
                    </div>

                    {/* 已安装的客户端 */}
                    {isInstalled && (
                        <div className="mb-4 p-3 bg-[var(--color-surface-hover)]/30 rounded-lg">
                            <p className="text-[12px] text-[var(--color-muted)] mb-2">{t('detail.installedIn')}</p>
                            <div className="flex flex-wrap gap-1">
                                {installedInClients.map(clientId => {
                                    const client = clients.find(c => c.id === clientId);
                                    return (
                                        <span key={clientId}
                                              className="flex items-center gap-1 px-2 py-0.5 rounded bg-[var(--color-surface-hover)] text-[12px] text-[var(--color-muted2)]">
                      <ClientIcon clientId={clientId} size={12}/>
                                            {client?.name || clientId}
                    </span>
                                    );
                                })}
                            </div>
                        </div>
                    )}

                    {/* Source 卡片 */}
                    {skillView.repositoryUrl && (
                        <div className="card p-4 space-y-3 mb-4">
                            <h3 className="text-[13px] font-semibold text-[var(--color-text)]">Source</h3>
                            <a href="#" onClick={(e) => {
                                e.preventDefault();
                                api.system.openExternal(skillView.repositoryUrl!);
                            }}
                               className="flex items-center justify-between text-[12px] text-[var(--color-muted2)] hover:text-[var(--color-accent)] transition-colors">
                <span className="flex items-center gap-2">
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                    <path fillRule="evenodd"
                          d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
                          clipRule="evenodd"/>
                  </svg>
                  GitHub Repository
                </span>
                                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"
                                     strokeWidth={2}>
                                    <path strokeLinecap="round" strokeLinejoin="round"
                                          d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25"/>
                                </svg>
                            </a>

                            {skillDirUrl && skillDirUrl !== skillView.repositoryUrl && (
                                <a href="#" onClick={(e) => {
                                    e.preventDefault();
                                    api.system.openExternal(skillDirUrl);
                                }}
                                   className="flex items-center justify-between text-[12px] text-[var(--color-muted2)] hover:text-[var(--color-accent)] transition-colors">
                  <span className="flex items-center gap-2">
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round"
                            d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5"/>
                    </svg>
                      {skillView.branch || 'main'}
                  </span>
                                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"
                                         strokeWidth={2}>
                                        <path strokeLinecap="round" strokeLinejoin="round"
                                              d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25"/>
                                    </svg>
                                </a>
                            )}

                            {skillView.skillMdRawUrl && (
                                <a href="#" onClick={(e) => {
                                    e.preventDefault();
                                    api.system.openExternal(skillView.skillMdRawUrl!);
                                }}
                                   className="flex items-center justify-between text-[12px] text-[var(--color-muted2)] hover:text-[var(--color-accent)] transition-colors">
                  <span className="flex items-center gap-2">
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round"
                            d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"/>
                    </svg>
                    Raw SKILL.md
                  </span>
                                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"
                                         strokeWidth={2}>
                                        <path strokeLinecap="round" strokeLinejoin="round"
                                              d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25"/>
                                    </svg>
                                </a>
                            )}
                        </div>
                    )}

                    {/* Source & Community（仅 registry skill） */}
                    {skillView.type === 'registry' && (
                        <div className="card p-4 mb-4">
                            <h3 className="text-[13px] font-semibold text-[var(--color-text)] mb-3">Source & Community</h3>
                            <div className="space-y-2 text-[12px]">
                                <div className="flex justify-between">
                                    <span className="text-[var(--color-muted)]">Repository</span>
                                    <span className="text-[var(--color-text)]">{skillView.author}</span>
                                </div>
                                {skillView.branch && (
                                    <div className="flex justify-between">
                                        <span className="text-[var(--color-muted)]">Branch</span>
                                        <span className="text-[var(--color-text)]">{skillView.branch}</span>
                                    </div>
                                )}
                                {(skillView.stars != null || skillView.forks != null || skillView.viewCount != null || skillView.downloads != null) && (
                                    <div className="flex justify-between">
                                        <span className="text-[var(--color-muted)]">Community</span>
                                        <span className="text-[var(--color-text)] flex items-center gap-1">
                      {skillView.stars != null && <><StarIcon
                          className="w-3 h-3 text-yellow-400"/>{formatNumber(skillView.stars)}</>}
                                            {skillView.viewCount != null && skillView.viewCount > 0 && <><EyeIcon
                          className="w-3 h-3 ms-1"/>{formatNumber(skillView.viewCount)}</>}
                                            {skillView.downloads != null && skillView.downloads > 0 && <><DownloadIcon
                          className="w-3 h-3 ms-1"/>{formatNumber(skillView.downloads)}</>}
                                            {skillView.forks != null && <><ForkIcon
                                                className="w-3 h-3 text-[var(--color-muted)] ms-1"/>{formatNumber(skillView.forks)}</>}
                    </span>
                                    </div>
                                )}
                                {skillView.updatedAt && (
                                    <div className="flex justify-between">
                                        <span className="text-[var(--color-muted)]">Updated At</span>
                                        <span className="text-[var(--color-text)]">{formatDate(skillView.updatedAt)}</span>
                                    </div>
                                )}
                            </div>
                        </div>
                    )}

                    {/* Skill Stats（仅 registry skill） */}
                    {skillView.type === 'registry' && skillView.stats && (
                        <div className="card p-4 mb-4">
                            <h3 className="text-[13px] font-semibold text-[var(--color-text)] mb-3">Skill Stats</h3>
                            <div className="space-y-2 text-[12px]">
                                <div className="flex justify-between">
                                    <span className="text-[var(--color-muted)]">SKILL.md</span>
                                    <span className="text-[var(--color-text)]">{skillView.skillMdLines || 0} Lines</span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-[var(--color-muted)]">Total Files</span>
                                    <span className="text-[var(--color-text)]">{skillView.stats.totalFiles || 0}</span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-[var(--color-muted)]">Total Size</span>
                                    <span className="text-[var(--color-text)]">{skillView.stats.totalSize || '0 B'}</span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-[var(--color-muted)]">License</span>
                                    <span className="text-[var(--color-text)]">{skillView.stats.license || 'NOASSERTION'}</span>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Files 列表 */}
                    {skillView.files.length > 0 && (
                        <div className="card p-4">
                            <h3 className="text-[13px] font-semibold text-[var(--color-text)] mb-3">
                                Files ({skillView.files.length})
                            </h3>
                            <div className="space-y-1.5">
                                {skillView.files.map((file) => (
                                    <div key={file.name}
                                         className="flex items-center justify-between p-2 rounded-md bg-[var(--color-surface-hover)]/30">
                                        <div className="flex items-center gap-2 min-w-0">
                                            <svg className="w-3.5 h-3.5 text-[var(--color-muted)] flex-shrink-0" fill="none"
                                                 viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                                <path strokeLinecap="round" strokeLinejoin="round"
                                                      d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"/>
                                            </svg>
                                            <span className="text-[12px] text-[var(--color-text)] truncate">{file.name}</span>
                                        </div>
                                        {file.size && <span
                                            className="text-[12px] text-[var(--color-muted)] flex-shrink-0 ms-2">{file.size}</span>}
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* 安装模态框 */}
            <Modal isOpen={showInstallModal} onClose={() => setShowInstallModal(false)}
                   title={t('skill.installTitle') || 'Install Skill'}>
                <div className="space-y-4">
                    <div className="flex items-center gap-3 p-3 bg-[var(--color-surface-hover)]/30 rounded-lg">
                        <SkillAvatar author={skillView.author} size={40}/>
                        <div>
                            <h3 className="text-[14px] font-medium text-[var(--color-text)]">{skillView.name}</h3>
                            {skillView.author && (
                                <p className="text-[12px] text-[var(--color-muted)]">by @{skillView.author}</p>
                            )}
                        </div>
                    </div>

                    <div>
                        <label
                            className="block text-[12px] font-medium text-[var(--color-text)] mb-2">{t('detail.selectClients')}</label>
                        <ClientMultiSelect
                            clients={clients.filter(c => c.installed && c.supportsSkills)}
                            selected={selectedClients}
                            onToggle={(id) => toggleClient(id as SkillClientType)}
                            className="grid grid-cols-2 gap-2"
                            iconSize={20}
                            check="check"
                            checkClassName="w-4 h-4"
                            variant="install"
                            stackedSublabel
                            disabledIds={installedInClients}
                            sublabel={{installed: t('detail.alreadyInstalled'), available: t('detail.available')}}
                            unselectedClass="bg-[var(--color-surface-hover)] border-[var(--color-border)] text-[var(--color-text)] hover:border-[var(--color-surface-active)]"
                        />
                    </div>

                    {clients.filter(c => c.installed && c.supportsSkills).length === 0 && (
                        <p className="text-center text-[var(--color-muted)] text-[13px] py-4">
                            {t('skill.noClientsSupport') || 'No installed clients support Skills'}
                        </p>
                    )}

                    <div className="flex justify-end gap-2 pt-2">
                        <button onClick={() => setShowInstallModal(false)}
                                className="btn btn-secondary">{t('common.cancel')}</button>
                        <button onClick={handleInstall} disabled={selectedClients.length === 0 || isInstalling}
                                className="btn btn-primary disabled:opacity-50">
                            {isInstalling ? t('common.loading') : t('detail.install')}
                        </button>
                    </div>
                </div>
            </Modal>
        </div>
    );
}
