from shoplive.backend.scraper.adapters.generic_adapter import parse_generic_page


def parse_aliexpress_page(product_url: str, html_text: str):
    return parse_generic_page(product_url, html_text, platform_hint="aliexpress")
