import {useTranslation} from 'react-i18next';
import {useNavigate} from 'react-router-dom';
import type {ClientInfo, InstalledSkill, SkillClientType} from '../lib/electron';
import SkillIcon from './SkillIcon';
import ClientIcon from './ClientIcon';
import LoadingSkeleton from './store/LoadingSkeleton';

interface LibrarySkillListProps {
    skills: InstalledSkill[];
    skillClients: Record<string, SkillClientType[]>;
    hasLoaded: boolean;
    selectMode: boolean;
    selectedSkills: string[];
    clients: ClientInfo[];
    refreshingSkill: string | null;
    onSkillClick: (skill: InstalledSkill) => void;
    onEditSkill: (skillName: string) => void;
    onUpdateSkill: (skillName: string) => void;
    onOpenSkillSync: (skillName: string) => void;
    onUninstall: (type: 'mcp' | 'skill', id: string, displayName: string, clients: string[]) => void;
    onToggleSelect: (skillName: string) => void;
}

export default function LibrarySkillList({
    skills,
    skillClients,
    hasLoaded,
    selectMode,
    selectedSkills,
    clients,
    refreshingSkill,
    onSkillClick,
    onEditSkill,
    onUpdateSkill,
    onOpenSkillSync,
    onUninstall,
    onToggleSelect,
}: LibrarySkillListProps) {
    const {t} = useTranslation();
    const navigate = useNavigate();

    if (!hasLoaded) return <LoadingSkeleton/>;

    if (skills.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center h-full">
                <div className="w-12 h-12 rounded-full bg-[var(--color-surface-hover)] flex items-center justify-center mb-3">
                    <svg className="w-6 h-6 text-[var(--color-muted)]" fill="none" viewBox="0 0 24 24"
                         stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round"
                              d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456zM16.894 20.567L16.5 21.75l-.394-1.183a2.25 2.25 0 00-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 001.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 001.423 1.423l1.183.394-1.183.394a2.25 2.25 0 00-1.423 1.423z"/>
                    </svg>
                </div>
                <p className="text-[13px] text-[var(--color-text)] mb-1">{t('library.noSkills') || 'No skills installed'}</p>
                <p className="text-[12px] text-[var(--color-muted)] mb-4">{t('library.noSkillsHint') || 'Visit the store to discover and install skills'}</p>
                <button onClick={() => navigate('/store')} className="btn btn-primary text-[13px]">
                    {t('installed.goToStore')}
                </button>
            </div>
        );
    }

    return (
        <div className="p-4">
            <div className="card overflow-hidden">
                {skills.map((skill, index) => {
                    const isSelected = selectedSkills.includes(skill.name);
                    const installedClients = skillClients[skill.name] || [];
                    return (
                        <div
                            key={skill.name}
                            className={`
                      flex items-center gap-3 px-4 py-3
                      ${selectMode ? 'cursor-pointer' : 'cursor-pointer hover:bg-[var(--color-surface-hover)]/50'}
                      transition-colors
                      ${index !== skills.length - 1 ? 'border-b border-[var(--color-border)]' : ''}
                      ${selectMode && isSelected ? 'bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)]' : ''}
                    `}
                            onClick={() => selectMode ? onToggleSelect(skill.name) : onSkillClick(skill)}
                        >
                            {/* 选择模式：复选框 */}
                            {selectMode ? (
                                <div className="flex-shrink-0">
                        <span
                            className={`w-4 h-4 rounded border flex items-center justify-center ${isSelected ? 'bg-[var(--color-accent)] border-[var(--color-accent)]' : 'border-[var(--color-border)]'}`}>
                          {isSelected && (
                              <svg className="w-3 h-3 text-[var(--color-text)]" fill="currentColor" viewBox="0 0 20 20">
                                  <path fillRule="evenodd"
                                        d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                                        clipRule="evenodd"/>
                              </svg>
                          )}
                        </span>
                                </div>
                            ) : (
                                <div className="flex-shrink-0">
                                    <SkillIcon skill={skill}/>
                                </div>
                            )}

                            {/* 内容 */}
                            <div className="flex-1 min-w-0">
                                <h3 className="text-[13px] font-medium text-[var(--color-text)] truncate">
                                    {skill.name}
                                </h3>
                                {/* 已安装的客户端 */}
                                <div className="flex items-center gap-2 mt-1">
                                    {installedClients.map(clientId => (
                                        <span key={clientId}
                                              className="text-[12px] text-[var(--color-muted2)] flex items-center gap-1">
                            <ClientIcon clientId={clientId} size={14}/>
                                            {clients.find(c => c.id === clientId)?.name}
                          </span>
                                    ))}
                                </div>
                            </div>

                            {/* 操作按钮区域（选择模式隐藏） */}
                            {!selectMode && (
                                <div className="flex items-center gap-2 flex-shrink-0"
                                     onClick={e => e.stopPropagation()}>
                                    {/* 来源标记 - 最左边 */}
                                    {skill.source ? (
                                        <span className="tag tag-info">AI-Tools</span>
                                    ) : (
                                        <span
                                            className="tag tag-default">{t('library.manual') || 'Manual'}</span>
                                    )}

                                    {/* 更新按钮 */}
                                    {skill.source && (
                                        <button
                                            onClick={() => onUpdateSkill(skill.name)}
                                            disabled={refreshingSkill === skill.name}
                                            className="p-1.5 rounded text-[var(--color-muted2)] hover:text-[var(--color-accent)] hover:bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)] transition-colors disabled:opacity-50"
                                            title={t('library.update') || 'Update'}
                                        >
                                            <svg
                                                className={`w-4 h-4 ${refreshingSkill === skill.name ? 'animate-spin' : ''}`}
                                                fill="none"
                                                viewBox="0 0 24 24"
                                                stroke="currentColor"
                                                strokeWidth={2}
                                            >
                                                <path strokeLinecap="round" strokeLinejoin="round"
                                                      d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99"/>
                                            </svg>
                                        </button>
                                    )}

                                    {/* 编辑按钮（商店来源的 Skill 也可编辑；保存后转为手动安装） */}
                                    <button
                                        onClick={() => onEditSkill(skill.name)}
                                        className="p-1.5 rounded text-[var(--color-muted2)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-hover)] transition-colors"
                                        title={t('installed.edit')}
                                    >
                                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24"
                                             stroke="currentColor" strokeWidth={2}>
                                            <path strokeLinecap="round" strokeLinejoin="round"
                                                  d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125"/>
                                        </svg>
                                    </button>

                                    {/* 同步到其他客户端 */}
                                    {installedClients.length > 0 && (
                                        <button
                                            onClick={() => onOpenSkillSync(skill.name)}
                                            className="p-1.5 rounded text-[var(--color-muted2)] hover:text-[var(--color-accent)] hover:bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)] transition-colors"
                                            title={t('library.sync') || 'Sync to clients'}
                                        >
                                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24"
                                                 stroke="currentColor" strokeWidth={2}>
                                                <path strokeLinecap="round" strokeLinejoin="round"
                                                      d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5"/>
                                            </svg>
                                        </button>
                                    )}

                                    {/* 删除按钮 */}
                                    <button
                                        onClick={() => onUninstall('skill', skill.name, skill.name, installedClients as string[])}
                                        className="p-1.5 rounded text-[var(--color-danger)] hover:bg-[color-mix(in_srgb,var(--color-danger)_10%,transparent)] transition-colors"
                                        title={t('installed.remove')}
                                    >
                                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24"
                                             stroke="currentColor" strokeWidth={2}>
                                            <path strokeLinecap="round" strokeLinejoin="round"
                                                  d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0"/>
                                        </svg>
                                    </button>
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
