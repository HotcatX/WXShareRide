import { z } from 'zod';
import { AppError } from '../errors.ts';

export type CodeExchange = (code: string) => Promise<{ openid: string }>;
const identitySchema = z.object({ openid: z.string().min(1).max(128), session_key: z.string().min(1) });

export function wechatCodeExchange(appId: string, appSecret: string | undefined): CodeExchange {
  return async code => {
    if (!appSecret) throw new AppError(503, 'LOGIN_UNAVAILABLE', '登录服务尚未配置');
    const url = new URL('https://api.weixin.qq.com/sns/jscode2session');
    url.search = new URLSearchParams({ appid: appId, secret: appSecret, js_code: code, grant_type: 'authorization_code' }).toString();
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'error' });
      if (!response.ok) throw new AppError(503, 'LOGIN_UNAVAILABLE', '登录服务暂不可用');
      const body = await response.json() as Record<string, unknown>;
      if (body.errcode === 40029 || body.errcode === 40163) throw new AppError(401, 'INVALID_LOGIN_CODE', '登录凭证已失效，请重试');
      if (body.errcode) throw new AppError(503, 'LOGIN_UNAVAILABLE', '登录服务暂不可用');
      const result = identitySchema.safeParse(body);
      if (!result.success) throw new AppError(503, 'LOGIN_UNAVAILABLE', '登录服务暂不可用');
      // session_key is not an application credential and never leaves this boundary.
      return { openid: result.data.openid };
    } catch (error) {
      if (error instanceof AppError) throw error;
      // Fetch errors can contain the secret-bearing URL. Never forward or log them.
      throw new AppError(503, 'LOGIN_UNAVAILABLE', '登录服务暂不可用');
    }
  };
}
