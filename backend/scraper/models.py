from dataclasses import dataclass, field
from typing import List


@dataclass
class FetchArtifact:
    engine: str
    url: str
    status_code: int
    html: str
    anti_bot: bool = False
    error: str = ""
    failure_tag: str = ""


@dataclass
class ParseResult:
    platform: str = "generic"
    product_name: str = ""
    description: str = ""
    image_urls: List[str] = field(default_factory=list)
    selling_points: List[str] = field(default_factory=list)
    review_highlights: List[str] = field(default_factory=list)
    review_positive_points: List[str] = field(default_factory=list)
    review_negative_points: List[str] = field(default_factory=list)
    review_summary: str = ""
    price: str = ""
    currency: str = ""
    source: str = "requests"
    confidence: str = "low"
    main_image_confidence: str = "low"
    review_extraction_method: str = "generic"

    def to_insight(self, language: str):
        lang = str(language or "zh").strip().lower()
        if lang not in {"zh", "en"}:
            lang = "zh"
        return {
            "product_name": self.product_name,
            "main_business": "鞋服配饰" if lang == "zh" else "fashion ecommerce",
            "style_template": "clean",
            "selling_points": self.selling_points[:6],
            "target_user": "",
            "sales_region": "",
            "brand_direction": "",
            "review_highlights": self.review_highlights[:6],
            "review_positive_points": self.review_positive_points[:6],
            "review_negative_points": self.review_negative_points[:6],
            "review_summary": self.review_summary,
            "image_urls": self.image_urls[:10],
            "platform": self.platform,
            "price": self.price,
            "currency": self.currency,
            "fetch_source": self.source,
            "fetch_confidence": self.confidence,
            "main_image_confidence": self.main_image_confidence,
            "review_extraction_method": self.review_extraction_method,
        }
