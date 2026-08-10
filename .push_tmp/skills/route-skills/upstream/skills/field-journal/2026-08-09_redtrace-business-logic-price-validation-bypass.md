# 业务逻辑漏洞：购买接口优惠券总额校验缺失

## 漏洞类型
Business Logic - Price Validation Bypass（业务逻辑 - 价格校验绕过）

## 技术细节
Flask/Werkzeug 电商应用中，购买接口 `/purchase` 接受 `product_id` 和 `coupon_ids` 参数。
前端 JS 通过 `Math.max(0, price - totalDiscount)` 计算最终价格，但服务端未二次校验优惠券总额是否足以覆盖商品原价。
攻击者仅需携带任意面值的一张有效优惠券即可购买任意商品，无需实际支付差额。

## 利用条件
- 目标应用登录仅需用户名，无密码认证
- 优惠券可通过 `/claim_coupon` 接口免费领取（每人限一张，随机10-100元）
- 购买接口未校验 `price - sum(coupon_values) <= 0`

## 检测方法
1. 获取有效 session 和优惠券
2. 向 `/purchase` 发送 `product_id=<高价商品>&coupon_ids=<低面值优惠券>`
3. 观察是否成功购买（响应中是否出现 flag/商品内容）

## 修复建议
- 服务端在购买逻辑中校验：`sum(coupon_values) >= product.price`
- 优惠券归属校验：确保 `coupon.owner == current_user`
- 添加服务端金额计算并记录审计日志
