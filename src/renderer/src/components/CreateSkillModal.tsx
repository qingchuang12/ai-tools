import {useEffect, useRef, useState} from 'react';
import {useTranslation} from 'react-i18next';
import ClientMultiSelect from './ClientMultiSelect';
import {type ClientInfo, type SkillClientType, type SkillFileItem, useElectronAPI} from '../lib/electron';
import {parseFrontmatter} from '../../../shared/frontmatter';

export interface CreateSkillModalProps {
    onClose: () => void;
    /** 全部客户端列表（含 supportsSkills 标记） */
    clients: ClientInfo[];
    /** 编辑模式：传入已安装 skill 的当前数据 */
    editData?: {
        name: string;
        description: string;
        body: string;
        clients: SkillClientType[];
    } | null;
    /** 默认选中的客户端（创建时） */
    defaultClients?: SkillClientType[];
    /** 提交回调：编辑时 originalName 为原名称，创建时为 undefined；zip 导入与附属文件面板变更随 files/removedFiles 携带 */
    onSubmit: (originalName: string | undefined, input: {
        name: string;
        description: string;
        body: string;
        files?: Array<{ path: string; data: Uint8Array }>;
        removedFiles?: string[];
    }, clients: SkillClientType[]) => Promise<{ success: boolean; error?: string }>;
}

export function CreateSkillModal({onClose, clients, editData, defaultClients, onSubmit}: CreateSkillModalProps) {
    const {t} = useTranslation();
    const api = useElectronAPI();
    const isEdit = !!editData;
    const skillClients = clients.filter(c => c.supportsSkills && c.installed);

    const [name, setName] = useState(editData?.name ?? '');
    const [description, setDescription] = useState(editData?.description ?? '');
    const [body, setBody] = useState(editData?.body ?? '');
    const [selectedClients, setSelectedClients] = useState<SkillClientType[]>(
        (editData?.clients ?? defaultClients ?? []) as SkillClientType[]
    );
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState('');
    const [confirmDiscard, setConfirmDiscard] = useState(false);
    /** 未选择目标客户端时点「创建/保存」的提示弹窗 */
    const [skillClientWarn, setSkillClientWarn] = useState(false);

    // 文件上传 / 拖拽解析状态（仅创建模式可用）
    const [uploading, setUploading] = useState(false);
    const [dragActive, setDragActive] = useState(false);
    /** zip 导入解出的附属文件（scripts/ 等），保存时一并写入目标客户端；编辑模式置空 */
    const [importFiles, setImportFiles] = useState<Array<{ path: string; data: Uint8Array }>>([]);

    // 附属文件编辑（仅编辑模式）——读取以首个已选客户端为基准，保存写入所有已选客户端
    const [files, setFiles] = useState<SkillFileItem[] | null>(null);
    const [activeFile, setActiveFile] = useState<string | null>(null);
    const [fileBase, setFileBase] = useState('');        // 读取时的原始内容（用于判断是否已修改）
    const [fileIsNew, setFileIsNew] = useState(false);   // 当前编辑的是暂存的新建文件（空内容也提交）
    const [fileContent, setFileContent] = useState('');  // 文本编辑区内容
    const [fileReadonly, setFileReadonly] = useState<{ reason: 'protected' | 'binary' | 'too_large' } | null>(null);
    const [fileReadError, setFileReadError] = useState('');
    /** 暂存的文件写入（path → UTF-8 bytes；含新建与修改） */
    const [modifiedFiles, setModifiedFiles] = useState<Record<string, Uint8Array>>({});
    /** 暂存的删除列表 */
    const [deletedFiles, setDeletedFiles] = useState<string[]>([]);
    const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
    const [showNewFile, setShowNewFile] = useState(false);
    const [newFilePath, setNewFilePath] = useState('');

    // 编辑模式：加载首个已选客户端的文件列表（基准 = 列表/内容读取来源）
    useEffect(() => {
        if (!isEdit || !editData || selectedClients.length === 0) return;
        api.skills.listSkillFiles(editData.name, selectedClients[0] as SkillClientType)
            .then(list => setFiles(list ?? []))
            .catch(() => setFiles([]));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isEdit]);

    const initialRef = useRef({
        name: editData?.name ?? '',
        description: editData?.description ?? '',
        body: editData?.body ?? '',
        clients: (editData?.clients ?? defaultClients ?? []) as SkillClientType[],
    });

    const hasFileChanges = Object.keys(modifiedFiles).length > 0 || deletedFiles.length > 0;

    const isDirty =
        name !== initialRef.current.name ||
        description !== initialRef.current.description ||
        body !== initialRef.current.body ||
        selectedClients.length !== initialRef.current.clients.length ||
        selectedClients.some(c => !initialRef.current.clients.includes(c)) ||
        hasFileChanges;

    const requestClose = () => {
        if (isDirty) {
            setConfirmDiscard(true);
        } else {
            onClose();
        }
    };

    const nameRef = useRef<HTMLInputElement>(null);
    useEffect(() => {
        nameRef.current?.focus();
    }, []);

    const handleParsedSkill = (res: {
        success: boolean;
        name?: string;
        description?: string;
        body?: string;
        files?: Array<{ path: string; data: Uint8Array }>;
        error?: string
    }) => {
        if (!res.success) {
            setError(res.error || (t('library.uploadFailed') || '解析失败'));
            return;
        }
        // 用户已手动填写的字段不覆盖，仅在为空时填充（避免覆盖用户输入）
        if (res.name && !name.trim()) setName(res.name);
        if (res.description && !description.trim()) setDescription(res.description);
        if (res.body && !body.trim()) setBody(res.body);
        // 保存 zip 附属文件：创建时随提交一并落盘（编辑模式忽略）
        if (res.files && res.files.length > 0) {
            setImportFiles(res.files);
            if (isEdit) setImportFiles([]);
        }
        setError('');
    };

    /**
     * 从正文自动识别技能名称与描述：
     *   1) 优先解析 YAML frontmatter 的 name / description
     *   2) 否则取首个「# 标题」作为名称，首个非空段落作为描述
     */
    const inferSkillMeta = (text: string): { name?: string; description?: string } => {
        const trimmed = (text || '').trim();
        if (!trimmed) return {};
        const fm = parseFrontmatter(trimmed);
        if (fm.name || fm.description) {
            return {name: fm.name, description: fm.description};
        }
        let nameCandidate: string | undefined;
        let descCandidate: string | undefined;
        const lines = trimmed.split(/\r?\n/);
        for (const line of lines) {
            const h = line.match(/^#{1,3}\s+(.+)$/);
            if (h && !nameCandidate) {
                nameCandidate = h[1].trim();
                continue;
            }
            if (!descCandidate && line.trim() && !/^#{1,6}\s/.test(line) && !/^---/.test(line)) {
                descCandidate = line.trim().replace(/\s+/g, ' ');
            }
        }
        return {name: nameCandidate, description: descCandidate};
    };

    // 正文失焦时，若名称/描述仍为空，则自动识别填充
    const handleBodyBlur = () => {
        if (name.trim() && description.trim()) return;
        const inferred = inferSkillMeta(body);
        if (!name.trim() && inferred.name) setName(inferred.name);
        if (!description.trim() && inferred.description) setDescription(inferred.description);
    };

    /** 移除单个导入的附属文件（创建模式：随 importFiles 不再落盘；不触盘，无需二次确认） */
    const removeImportFile = (path: string) => {
        setImportFiles(prev => prev.filter(f => f.path !== path));
    };

    /** 文件大小展示（B / KB） */
    const formatFileSize = (n: number): string =>
        n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`;

    const handleFile = async (file: File) => {
        // zip/.skill/.md 一律走「内存字节通道」：renderer 把 File 读成 bytes 传给主进程解析，
        // 不依赖 Electron 旧式 file.path（沙箱/新版下可能为 undefined 导致拖拽报错）。
        // .md 由主进程按文本读取；zip/.skill 由 archive 解包。仅目录选择仍走 pickFolder + importFromFile。
        const lower = (file.name || '').toLowerCase();
        const ok = lower.endsWith('.zip') || lower.endsWith('.skill') || lower.endsWith('.md');
        if (!ok) {
            setError(t('library.uploadOnlyFormats') || '仅支持 .zip / .skill / .md 文件');
            return;
        }
        setUploading(true);
        setError('');
        try {
            const data = new Uint8Array(await file.arrayBuffer());
            const res = await api.skills.importFromZipBuffer(data);
            handleParsedSkill(res);
        } catch (e: any) {
            setError(e?.message || (t('library.uploadFailed') || '解析失败'));
        } finally {
            setUploading(false);
        }
    };

    // 统一选择入口：点击拖拽区弹出「文件 / 文件夹」两个明确选项。
    // 说明：Electron 官方文档明确——Windows/Linux 上 openFile + openDirectory 不能并存于同一对话框，
    // 只会显示文件夹选择器。故文件选择走原生 file input（跨平台可靠），文件夹选择走 pickFolder IPC。
    const [importMenuOpen, setImportMenuOpen] = useState(false);
    const importFileInputRef = useRef<HTMLInputElement>(null);

    /** 选择文件夹（已解压的 skill 目录） */
    const handlePickFolder = async () => {
        if (isEdit || uploading) return;
        setUploading(true);
        setError('');
        try {
            const res = await api.skills.pickFolder();
            if (res.canceled || !res.path) return;
            const parsed = await api.skills.importFromFile(res.path);
            handleParsedSkill(parsed);
        } catch (e: any) {
            setError(e?.message || (t('library.uploadFailed') || '解析失败'));
        } finally {
            setUploading(false);
        }
    };

    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        setDragActive(false);
        if (isEdit || uploading) return;
        const file = e.dataTransfer.files?.[0];
        if (file) void handleFile(file);
    };

    // ==================== 附属文件（编辑模式） ====================

    /** 打开附属文件：文本 → 编辑区；二进制/超大 → 只读提示；受保护 → 只读（正文区编辑） */
    const openSkillFile = async (f: SkillFileItem) => {
        if (!isEdit || !editData || selectedClients.length === 0) return;
        setActiveFile(f.path);
        if (deletedFiles.includes(f.path)) {
            setFileIsNew(false);
            setFileReadError(t('library.fileDeleted') || '已标记删除');
            setFileContent('');
            setFileReadonly(null);
            return;
        }
        // 暂存态直接展示当前内容（不再回读磁盘；编辑基准为空串，无法还原到磁盘原样）
        if (modifiedFiles[f.path]) {
            setFileIsNew(false);
            setFileBase('');
            setFileContent(new TextDecoder().decode(modifiedFiles[f.path]));
            setFileReadonly(null);
            setFileReadError('');
            return;
        }
        if (f.kind === 'protected') {
            setFileIsNew(false);
            setFileContent('');
            setFileReadonly({reason: 'protected'});
            setFileReadError('');
            return;
        }
        try {
            const res = await api.skills.readSkillFile(editData.name, selectedClients[0] as SkillClientType, f.path);
            if (res.success && res.mode === 'editable') {
                setFileIsNew(false);
                setFileBase(res.content);
                setFileContent(res.content);
                setFileReadonly(null);
                setFileReadError('');
            } else if (res.success) {
                setFileIsNew(false);
                setFileBase('');
                setFileContent('');
                setFileReadonly({reason: res.reason});
                setFileReadError('');
            } else {
                setFileReadonly(null);
                setFileReadError(res.error || t('library.fileReadFailed'));
            }
        } catch (e: any) {
            setFileReadonly(null);
            setFileReadError(e?.message || t('library.fileReadFailed'));
        }
    };

    /** 编辑区变更：内容相对基准有变化才写入暂存；还原到基准自动撤销修改（新建文件空内容也保留） */
    const handleFileContentChange = (value: string) => {
        if (!activeFile) return;
        setFileContent(value);
        const changed = fileIsNew || value !== fileBase;
        setModifiedFiles(prev => {
            const next = {...prev};
            if (changed) {
                next[activeFile] = new TextEncoder().encode(value);
            } else {
                delete next[activeFile];
            }
            return next;
        });
    };

    /** 新建文本文件：输入相对路径后进入编辑区（内容留空可直接保存） */
    const handleNewFile = () => {
        const rel = (newFilePath || '').trim();
        if (!rel) return;
        setNewFilePath('');
        setShowNewFile(false);
        setConfirmDelete(null);
        setDeletedFiles(prev => prev.filter(p => p !== rel));
        setActiveFile(rel);
        setFileBase('');
        setFileIsNew(true);
        setFileContent('');
        setFileReadonly(null);
        setFileReadError('');
        setModifiedFiles(prev => ({...prev, [rel]: new TextEncoder().encode('')}));
    };

    /** 删除附属文件：二次确认后标记删除（随保存生效） */
    const handleDeleteFile = (f: SkillFileItem) => {
        if (f.kind === 'protected') return;
        if (confirmDelete === f.path) {
            setConfirmDelete(null);
            setDeletedFiles(prev => (prev.includes(f.path) ? prev : [...prev, f.path]));
            setModifiedFiles(prev => {
                const next = {...prev};
                delete next[f.path];
                return next;
            });
            if (activeFile === f.path) {
                setActiveFile(null);
                setFileContent('');
                setFileReadonly(null);
                setFileReadError('');
            }
        } else {
            setConfirmDelete(f.path);
        }
    };

    const toggleClient = (id: SkillClientType) => {
        setSelectedClients(prev =>
            prev.includes(id) ? prev.filter(c => c !== id) : [...prev, id]
        );
    };

    const handleSubmit = async () => {
        if (!name.trim()) {
            setError(t('library.skillNameRequired') || '请输入 Skill 名称');
            return;
        }
        if (selectedClients.length === 0) {
            setSkillClientWarn(true);
            return;
        }
        setSubmitting(true);
        setError('');
        try {
            const result = await onSubmit(
                isEdit ? editData!.name : undefined,
                {
                    name: name.trim(),
                    description: description.trim(),
                    body: body.trim(),
                    // 创建模式：zip 导入的附属文件随提交落盘；
                    // 编辑模式：附属文件面板的修改/新建（modifiedFiles）与删除（deletedFiles）统一提交
                    files: !isEdit
                        ? (importFiles.length > 0 ? importFiles : undefined)
                        : (Object.keys(modifiedFiles).length > 0
                            ? Object.entries(modifiedFiles).map(([path, data]) => ({path, data}))
                            : undefined),
                    removedFiles: deletedFiles.length > 0 ? [...deletedFiles] : undefined,
                },
                selectedClients
            );
            if (!result.success) {
                setError(result.error || (t('library.skillSaveFailed') || '保存失败'));
                setSubmitting(false);
            } else {
                onClose();
            }
        } catch (e: any) {
            setError(e?.message || (t('library.skillSaveFailed') || '保存失败'));
            setSubmitting(false);
        }
    };

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--color-bg)]/50 backdrop-blur-sm"
            onClick={e => {
                if (e.target === e.currentTarget) requestClose();
            }}
        >
            <div
                className="w-[640px] max-w-[92vw] max-h-[88vh] overflow-y-auto rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-2xl"
            >
                <div className="flex items-center justify-between border-b border-[var(--color-border)] px-6 py-4">
                    <h2 className="text-[14px] font-semibold text-[var(--color-text)]">
                        {isEdit ? (t('library.editSkill') || '编辑 Skill') : (t('library.createCustomSkill') || '新建自定义 Skill')}
                    </h2>
                    <button onClick={requestClose}
                            className="rounded-md p-1 text-[var(--color-muted2)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                             strokeWidth="2" strokeLinecap="round">
                            <path d="M18 6 6 18M6 6l12 12"/>
                        </svg>
                    </button>
                </div>

                <div className="space-y-5 px-6 py-5">
                    {error && (
                        <div
                            className="flex items-start gap-2 rounded-lg border border-[#ff3b30]/40 bg-[#ff3b30]/10 px-3 py-2 text-[12px] text-[#ff6961]">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                                 strokeWidth="2" className="mt-0.5 shrink-0">
                                <circle cx="12" cy="12" r="10"/>
                                <path d="M12 8v4M12 16h.01"/>
                            </svg>
                            <span>{error}</span>
                        </div>
                    )}

                    {!isEdit && (
                        <div
                            onClick={() => {
                                if (!uploading) setImportMenuOpen(true);
                            }}
                            onDragOver={(e) => {
                                e.preventDefault();
                                if (!uploading) setDragActive(true);
                            }}
                            onDragLeave={() => setDragActive(false)}
                            onDrop={handleDrop}
                            className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-6 text-center transition-colors ${
                                dragActive
                                    ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/10'
                                    : 'border-[var(--color-border)] bg-[var(--color-bg)] hover:border-[var(--color-muted)]'
                            } ${uploading ? 'pointer-events-none opacity-60' : ''}`}
                        >
                            {uploading ? (
                                <>
                                    <svg className="h-6 w-6 animate-spin text-[var(--color-accent)]" fill="none" viewBox="0 0 24 24"
                                         stroke="currentColor" strokeWidth={2}>
                                        <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
                                    </svg>
                                    <p className="text-[12px] text-[var(--color-muted2)]">{t('library.uploadParsing') || '正在解析…'}</p>
                                </>
                            ) : (
                                <>
                                    <svg className="h-6 w-6 text-[var(--color-muted)]" fill="none" viewBox="0 0 24 24"
                                         stroke="currentColor" strokeWidth={1.5}>
                                        <path strokeLinecap="round" strokeLinejoin="round"
                                              d="M12 16.5V9m0 0L8.25 12.75M12 9l3.75 3.75M3 15v1.5A2.25 2.25 0 0 0 5.25 19.5h13.5A2.25 2.25 0 0 0 21 16.5V15"/>
                                    </svg>
                                    <p className="text-[12px] font-medium text-[var(--color-text)]">{t('library.uploadSkillHint') || '拖入 Skill 文件，或点击选择'}</p>
                                    <p className="text-[12px] text-[var(--color-muted)]">{t('library.uploadFormats') || '支持 .zip / .skill / 已解压文件夹 / .md 文档'}</p>
                                </>
                            )}
                        </div>
                    )}

                    {/* 隐藏的文件选择框：点击「导入 Skill 文件」时触发（原生 file input，跨平台可靠） */}
                    {!isEdit && (
                        <input
                            ref={importFileInputRef}
                            type="file"
                            accept=".zip,.skill,.md"
                            className="hidden"
                            onChange={e => {
                                const f = e.target.files?.[0];
                                if (f) void handleFile(f);
                                e.target.value = '';
                            }}
                        />
                    )}

                    {/* 导入方式选择浮层：文件 / 文件夹 二选一 */}
                    {importMenuOpen && (
                        <div
                            className="fixed inset-0 z-[60] flex items-center justify-center bg-[var(--color-bg)]/60"
                            onClick={e => {
                                if (e.target === e.currentTarget) setImportMenuOpen(false);
                            }}
                        >
                            <div className="w-[320px] max-w-[88vw] rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-2xl">
                                <h3 className="text-[14px] font-semibold text-[var(--color-text)]">{t('library.importTitle') || '导入 Skill'}</h3>
                                <div className="mt-4 space-y-2">
                                    <button
                                        onClick={() => {
                                            setImportMenuOpen(false);
                                            importFileInputRef.current?.click();
                                        }}
                                        className="flex w-full items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-3 text-start text-[13px] text-[var(--color-text)] transition-colors hover:border-[var(--color-accent)] hover:bg-[var(--color-accent)]/10"
                                    >
                                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                                             strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
                                             className="shrink-0 text-[var(--color-muted2)]">
                                            <path d="M18.5 3.5a2.121 2.121 0 0 1 3 3L7 21l-4 1 1-4L18.5 3.5z"/>
                                        </svg>
                                        <span>{t('library.importFromFile') || 'Skill 文件（.zip / .skill / .md）'}</span>
                                    </button>
                                    <button
                                        onClick={() => {
                                            setImportMenuOpen(false);
                                            void handlePickFolder();
                                        }}
                                        className="flex w-full items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-3 text-start text-[13px] text-[var(--color-text)] transition-colors hover:border-[var(--color-accent)] hover:bg-[var(--color-accent)]/10"
                                    >
                                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                                             strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
                                             className="shrink-0 text-[var(--color-muted2)]">
                                            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/>
                                        </svg>
                                        <span>{t('library.importFromFolder') || 'Skill 文件夹（已解压的目录）'}</span>
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}

                    <div>
                        <label
                            className="mb-1.5 block text-[12px] font-medium text-[var(--color-muted2)]">{t('library.name') || '名称'}</label>
                        <input
                            ref={nameRef}
                            value={name}
                            onChange={e => setName(e.target.value)}
                            placeholder={t('library.skillNamePlaceholder') || 'my-custom-skill'}
                            className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-[13px] text-[var(--color-text)] outline-none transition-colors focus:border-[var(--color-accent)]"
                        />
                        <p className="mt-1 text-[12px] text-[var(--color-muted)]">{t('library.skillNameHint') || '仅允许字母、数字、点、中划线、下划线，将作为目录名'}</p>
                    </div>

                    <div>
                        <label
                            className="mb-1.5 block text-[12px] font-medium text-[var(--color-muted2)]">{t('library.description') || '描述'}</label>
                        <input
                            value={description}
                            onChange={e => setDescription(e.target.value)}
                            placeholder={t('library.skillDescPlaceholder') || '一句话描述这个 Skill 的用途'}
                            className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-[13px] text-[var(--color-text)] outline-none transition-colors focus:border-[var(--color-accent)]"
                        />
                    </div>

                    <div>
                        <label
                            className="mb-1.5 block text-[12px] font-medium text-[var(--color-muted2)]">SKILL.md {t('library.content') || '正文'}</label>
                        <textarea
                            value={body}
                            onChange={e => setBody(e.target.value)}
                            onBlur={handleBodyBlur}
                            rows={10}
                            placeholder={t('library.skillBodyPlaceholder') || '描述 Skill 的用途、使用场景与示例……'}
                            className="w-full resize-y rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 font-mono text-[12px] leading-relaxed text-[var(--color-text)] outline-none transition-colors focus:border-[var(--color-accent)]"
                        />
                    </div>

                    {/* 附属文件清单：创建模式导入解析后展示（类似编辑面板列表），可移除单项；保存时随 importFiles 落盘 */}
                    {!isEdit && importFiles.length > 0 && (
                        <div>
                            <div className="mb-2 flex items-center justify-between">
                                <label
                                    className="text-[12px] font-medium text-[var(--color-muted2)]">{t('library.attachedFiles') || '附属文件'}
                                    <span className="ms-1 text-[var(--color-muted)]">({importFiles.length})</span></label>
                                <span className="text-[11px] text-[var(--color-muted)]">{t('library.fileImportHint') || '随 Skill 一并导入，保存时写入目标客户端'}</span>
                            </div>
                            <div className="max-h-[150px] overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]">
                                {importFiles.map(f => (
                                    <div key={f.path}
                                         className="flex items-center gap-2 border-b border-[var(--color-border)] px-3 py-1.5 last:border-b-0">
                                        <span className="flex-1 truncate font-mono text-[12px] text-[var(--color-text)]">{f.path}</span>
                                        <span className="text-[10px] text-[var(--color-muted)]">{formatFileSize(f.data.byteLength)}</span>
                                        <button
                                            onClick={() => removeImportFile(f.path)}
                                            className="rounded px-1.5 py-0.5 text-[10px] text-[var(--color-muted2)] transition-colors hover:bg-[#ff3b30]/10 hover:text-[#ff6961]"
                                        >
                                            {t('library.fileRemove') || '移除'}
                                        </button>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* 附属文件面板：仅编辑模式；修改/新建/删除暂存，随「保存」统一提交 */}
                    {isEdit && (
                        <div>
                            <div className="mb-2 flex items-center justify-between">
                                <label
                                    className="text-[12px] font-medium text-[var(--color-muted2)]">{t('library.attachedFiles') || '附属文件'}</label>
                                <button
                                    onClick={() => setShowNewFile(v => !v)}
                                    className="flex items-center gap-1 rounded-md border border-[var(--color-border)] px-2 py-1 text-[11px] text-[var(--color-muted2)] transition-colors hover:border-[var(--color-muted)] hover:text-[var(--color-text)]"
                                >
                                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                                         strokeWidth="2.5" strokeLinecap="round">
                                        <path d="M12 5v14M5 12h14"/>
                                    </svg>
                                    {t('library.fileNew') || '新建'}
                                </button>
                            </div>

                            {showNewFile && (
                                <div className="mb-2 flex gap-2">
                                    <input
                                        value={newFilePath}
                                        onChange={e => setNewFilePath(e.target.value)}
                                        onKeyDown={e => {
                                            if (e.key === 'Enter') handleNewFile();
                                        }}
                                        placeholder={t('library.fileNewPlaceholder') || 'scripts/new.py'}
                                        className="flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 font-mono text-[12px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
                                    />
                                    <button
                                        onClick={handleNewFile}
                                        disabled={!newFilePath.trim()}
                                        className="rounded-lg bg-[var(--color-accent)] px-3 py-2 text-[12px] font-medium text-white transition-colors hover:bg-[var(--color-accent)]/85 disabled:opacity-50"
                                    >
                                        {t('common.confirm') || '确定'}
                                    </button>
                                </div>
                            )}

                            {files === null ? (
                                <p className="text-[12px] text-[var(--color-muted)]">{t('library.fileLoading') || '加载中…'}</p>
                            ) : files.length === 0 ? (
                                <p className="text-[12px] text-[var(--color-muted2)]">{t('library.fileNone') || '无附属文件'}</p>
                            ) : (
                                <div
                                    className="max-h-[150px] overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]">
                                    {files.map(f => {
                                        const deleted = deletedFiles.includes(f.path);
                                        const modified = !!modifiedFiles[f.path];
                                        return (
                                            <div
                                                key={f.path}
                                                onClick={() => !deleted && openSkillFile(f)}
                                                className={`flex cursor-pointer items-center gap-2 border-b border-[var(--color-border)] px-3 py-1.5 last:border-b-0 ${
                                                    activeFile === f.path && !deleted
                                                        ? 'bg-[var(--color-accent)]/10'
                                                        : 'hover:bg-[var(--color-surface-hover)]'
                                                } ${deleted ? 'opacity-50' : ''}`}
                                            >
                                                <span className="flex-1 truncate font-mono text-[12px] text-[var(--color-text)]">{f.path}</span>
                                                {f.kind === 'protected' && (
                                                    <span className="rounded bg-[var(--color-muted)]/15 px-1.5 py-0.5 text-[10px] text-[var(--color-muted2)]">
                                                        {t('library.fileProtected') || '正文'}
                                                    </span>
                                                )}
                                                {!deleted && f.kind !== 'protected' && (
                                                    <span className="text-[10px] text-[var(--color-muted)]">
                                                        {formatFileSize(f.size)}
                                                    </span>
                                                )}
                                                {modified && (
                                                    <span className="rounded bg-[var(--color-accent)]/15 px-1.5 py-0.5 text-[10px] text-[var(--color-accent)]">
                                                        {t('library.fileModified') || '已修改'}
                                                    </span>
                                                )}
                                                {deleted && (
                                                    <span className="rounded bg-[#ff3b30]/15 px-1.5 py-0.5 text-[10px] text-[#ff6961]">
                                                        {t('library.fileDeletedTag') || '已删除'}
                                                    </span>
                                                )}
                                                <button
                                                    onClick={e => {
                                                        e.stopPropagation();
                                                        handleDeleteFile(f);
                                                    }}
                                                    disabled={f.kind === 'protected'}
                                                    className={`rounded px-1.5 py-0.5 text-[10px] transition-colors disabled:opacity-30 ${
                                                        confirmDelete === f.path
                                                            ? 'bg-[#ff3b30] text-white'
                                                            : 'text-[var(--color-muted2)] hover:bg-[#ff3b30]/10 hover:text-[#ff6961]'
                                                    }`}
                                                >
                                                    {confirmDelete === f.path
                                                        ? (t('library.fileConfirmDelete') || '确认删除')
                                                        : (t('library.fileDelete') || '删除')}
                                                </button>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}

                            {activeFile && (
                                <div className="mt-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
                                    <div className="mb-1.5 flex items-center gap-2">
                                        <span className="flex-1 break-all font-mono text-[12px] text-[var(--color-text)]">{activeFile}</span>
                                        {fileReadonly?.reason === 'protected' && (
                                            <span className="text-[11px] text-[var(--color-muted2)]">
                                                {t('library.fileProtectedHint') || 'SKILL.md 受保护，请在正文区域编辑'}
                                            </span>
                                        )}
                                        {fileReadonly?.reason === 'binary' && (
                                            <span className="text-[11px] text-[var(--color-muted2)]">
                                                {t('library.fileBinary') || '二进制文件，只读'}
                                            </span>
                                        )}
                                        {fileReadonly?.reason === 'too_large' && (
                                            <span className="text-[11px] text-[var(--color-muted2)]">
                                                {t('library.fileTooLarge') || '文件过大（>512KB），只读'}
                                            </span>
                                        )}
                                    </div>
                                    {fileReadError && <p className="text-[12px] text-[#ff6961]">{fileReadError}</p>}
                                    {!fileReadonly && !fileReadError && (
                                        <textarea
                                            value={fileContent}
                                            onChange={e => handleFileContentChange(e.target.value)}
                                            rows={8}
                                            placeholder={t('library.fileEditPlaceholder') || '在此编辑文件内容……'}
                                            className="w-full resize-y rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 font-mono text-[12px] leading-relaxed text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
                                        />
                                    )}
                                </div>
                            )}
                        </div>
                    )}

                    <div>
                        <label
                            className="mb-2 block text-[12px] font-medium text-[var(--color-muted2)]">{t('library.targetClients') || '目标客户端'}</label>
                        <ClientMultiSelect
                            clients={skillClients}
                            selected={selectedClients}
                            onToggle={(id) => toggleClient(id as SkillClientType)}
                            className="grid grid-cols-2 gap-2 sm:grid-cols-3"
                            iconSize={14}
                            check="square"
                            leadingCheck
                            variant="sync"
                            baseClass="flex items-center gap-2 rounded-lg border px-3 py-2 text-[12px] transition-colors"
                            selectedClass="border-[var(--color-accent)] bg-[var(--color-accent)]/15 text-white"
                            unselectedClass="border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-muted2)] hover:border-[var(--color-muted)]"
                        />
                    </div>
                </div>

                <div className="flex justify-end gap-3 border-t border-[var(--color-border)] px-6 py-4">
                    <button
                        onClick={requestClose}
                        className="rounded-lg border border-[var(--color-border)] px-4 py-2 text-[13px] text-[var(--color-muted2)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]"
                    >
                        {t('common.cancel') || '取消'}
                    </button>
                    <button
                        onClick={handleSubmit}
                        disabled={submitting}
                        className="flex items-center gap-2 rounded-lg bg-[var(--color-accent)] px-4 py-2 text-[13px] font-medium text-white transition-colors hover:bg-[var(--color-accent)]/85 disabled:opacity-50"
                    >
                        {submitting && (
                            <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none"
                                 stroke="currentColor" strokeWidth="2">
                                <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
                            </svg>
                        )}
                        {isEdit ? (t('common.save') || '保存') : (t('library.create') || '创建')}
                    </button>
                </div>
            </div>

            {confirmDiscard && (
                <div
                    className="fixed inset-0 z-[60] flex items-center justify-center bg-[var(--color-bg)]/60"
                    onClick={e => {
                        if (e.target === e.currentTarget) setConfirmDiscard(false);
                    }}
                >
                    <div
                        className="w-[380px] max-w-[88vw] rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-2xl">
                        <h3 className="text-[14px] font-semibold text-[var(--color-text)]">{t('library.discardTitle') || '放弃编辑内容？'}</h3>
                        <p className="mt-2 text-[12px] leading-relaxed text-[var(--color-muted2)]">{t('library.discardHint') || '您已修改内容但尚未保存，关闭后将丢失这些改动。'}</p>
                        <div className="mt-5 flex justify-end gap-3">
                            <button
                                onClick={() => setConfirmDiscard(false)}
                                className="rounded-lg border border-[var(--color-border)] px-4 py-2 text-[13px] text-[var(--color-muted2)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]"
                            >
                                {t('library.keepEditing') || '继续编辑'}
                            </button>
                            <button
                                onClick={() => {
                                    setConfirmDiscard(false);
                                    onClose();
                                }}
                                className="rounded-lg bg-[#ff3b30] px-4 py-2 text-[13px] font-medium text-white transition-colors hover:bg-[#ff3b30]/85"
                            >
                                {t('library.discardChanges') || '放弃'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        {skillClientWarn && (
                <div
                    className="fixed inset-0 z-[60] flex items-center justify-center bg-[var(--color-bg)]/60"
                    onClick={e => {
                        if (e.target === e.currentTarget) setSkillClientWarn(false);
                    }}
                >
                    <div
                        className="w-[380px] max-w-[88vw] rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-2xl">
                        <h3 className="text-[14px] font-semibold text-[var(--color-text)]">{t('library.skillClientRequiredTitle') || '请选择目标客户端'}</h3>
                        <p className="mt-2 text-[12px] leading-relaxed text-[var(--color-muted2)]">
                            {t('library.skillClientRequiredHint') || '保存 Skill 前请至少选择一个目标客户端。只有勾选「云端」，Skill 才会同步到云端存储；未勾选则不会。'}
                        </p>
                        <div className="mt-5 flex justify-end gap-3">
                            <button
                                onClick={() => setSkillClientWarn(false)}
                                className="rounded-lg bg-[var(--color-accent)] px-4 py-2 text-[13px] font-medium text-white transition-colors hover:bg-[var(--color-accent)]/85"
                            >
                                {t('common.confirm') || '确定'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
