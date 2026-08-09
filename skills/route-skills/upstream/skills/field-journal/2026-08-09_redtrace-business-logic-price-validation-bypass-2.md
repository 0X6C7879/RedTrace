# 电商应用购买接口未校验优惠券总额是否覆盖商品价格，导致可低价/免费购买高价值商品

Flask/Werkzeug 电商应用中 /purchase 接口接受 product_id 和 coupon_ids 参数，前端 JS 通过 Math.max(0, price - totalDiscount) 计算展示价格，但服务端未二次校验优惠券总额是否足以覆盖商品原价。攻击者仅需携带任意面值的一张有效优惠券即可购买任意商品。检测：获取 session 和优惠券后 POST /purchase product_id=<高价>&coupon_ids=<低面值>，观察是否成功。修复：服务端校验 sum(coupon_values) >= product.price 并验证 coupon.owner == current_user。
