/**
 * 广告适配器契约：AdSlot 不感知渠道差异，渠道细节全部收在 AdProvider 实现内
 * （Overwolf 原生 Ads 容器与 360 SDK 接入方式差异大，靠此接口隔离）。
 */

/** 广告位尺寸（IAB 标准单元；Overwolf 要求容器为标准 IAB 尺寸） */
export type AdSlotSize = '728x90' | '300x250' | '160x600' | '300x600' | '970x250';

export interface AdProvider {
    readonly name: string;
    /** 把广告挂载到容器；resolve false = 本环境/渠道不可用（调用方静默隐藏容器，不影响主功能） */
    init(container: HTMLElement): Promise<boolean>;
    /**
     * 主动请求一次填充；自管理型渠道（owadview 自动拉取/刷新）无需实现。
     * resolve false = 本次未填充。
     */
    loadBanner?(): Promise<boolean>;
    /** 释放资源（移除注入的 DOM / 销毁 SDK 实例）；组件卸载与激活后隐藏时调用 */
    destroy(): void;
}
