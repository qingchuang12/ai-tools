import type {AdProvider} from './types';

/** 恒不填充的兜底 provider：免费版2 / 渠道不可用时由 selectAdProvider 选中 */
export class NoopAdProvider implements AdProvider {
    readonly name = 'noop';

    init(): Promise<boolean> {
        return Promise.resolve(false);
    }

    destroy(): void {
        // 占位实现无资源
    }
}
