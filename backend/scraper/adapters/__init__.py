from shoplive.backend.scraper.adapters.generic_adapter import (
    assess_parse_quality,
    guess_platform,
    is_anti_bot_page,
    parse_generic_page,
)
from shoplive.backend.scraper.adapters.amazon_adapter import parse_amazon_page
from shoplive.backend.scraper.adapters.ebay_adapter import parse_ebay_page
from shoplive.backend.scraper.adapters.aliexpress_adapter import parse_aliexpress_page
from shoplive.backend.scraper.adapters.temu_adapter import parse_temu_page
from shoplive.backend.scraper.adapters.etsy_adapter import parse_etsy_page
from shoplive.backend.scraper.adapters.walmart_adapter import parse_walmart_page
from shoplive.backend.scraper.adapters.tiktok_shop_adapter import parse_tiktok_shop_page
from shoplive.backend.scraper.adapters.taobao_adapter import parse_taobao_page
from shoplive.backend.scraper.adapters.jd_adapter import parse_jd_page
from shoplive.backend.scraper.adapters.shein_adapter import parse_shein_page

PLATFORM_ADAPTERS = {
    "shein": parse_shein_page,
    "amazon": parse_amazon_page,
    "ebay": parse_ebay_page,
    "aliexpress": parse_aliexpress_page,
    "temu": parse_temu_page,
    "etsy": parse_etsy_page,
    "walmart": parse_walmart_page,
    "tiktok-shop": parse_tiktok_shop_page,
    "taobao": parse_taobao_page,
    "jd": parse_jd_page,
    "shopify": parse_generic_page,
    "shoplazza": parse_generic_page,
    "generic": parse_generic_page,
}


def get_platform_parser(platform: str):
    return PLATFORM_ADAPTERS.get(str(platform or "generic").strip().lower(), parse_generic_page)

__all__ = [
    "assess_parse_quality",
    "guess_platform",
    "is_anti_bot_page",
    "parse_generic_page",
    "parse_shein_page",
    "get_platform_parser",
]
