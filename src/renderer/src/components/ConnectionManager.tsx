/**
 * API 直连管理卡片（P2-6）
 * 实现已抽到通用 SourceManager，本文件仅做参数化薄 wrapper。
 */
import {BUILTIN_SKILL_SOURCE_IDS, PLATFORM_META, SKILL_PLATFORM_TYPES} from '../../../shared/platform-constants';
import SourceManager from './SourceManager';
import {useTranslation} from 'react-i18next';

interface Props {
    /** 源列表变化后通知外部（Store 下拉需要重新拉取） */
    onChanged?: () => void;
}

export default function ConnectionManager({onChanged}: Props) {
    const {t} = useTranslation();
    return (
        <SourceManager
            namespace="skillSource"
            kind="skill"
            platformTypes={SKILL_PLATFORM_TYPES}
            builtinIds={[BUILTIN_SKILL_SOURCE_IDS.clawhub]}
            createDefaults={{platformType: 'modelscope', baseUrl: PLATFORM_META.modelscope.defaultBaseUrl}}
            exportNames={{single: 'connection.json', multi: 'connections.json'}}
            unknownPlatformFallback
            platformKeyHints={{
                // 虾评列表匿名可读，但下载安装需鉴权；正式版技能下载会扣 2 虾米（重试不重复扣）。
                coze: (
                    <>
                        {t('skillSource.cozeHintPrefix')}{' '}
                        <a
                            href="https://xiaping.coze.com/skill.md"
                            target="_blank"
                            rel="noreferrer"
                            className="text-[var(--color-accent)] hover:underline"
                        >
                            xiaping.coze.com/skill.md
                        </a>
                        {t('skillSource.cozeHintSuffix')}
                    </>
                ),
            }}
            onChanged={onChanged}
        />
    );
}
