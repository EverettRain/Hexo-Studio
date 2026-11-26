import { describe, expect, it } from "vitest";
import { renderInstant } from "./instantPreview";

describe("renderInstant", () => {
  it("renders Markdown as the blog's markdown-it would", () => {
    // Act
    const html = renderInstant("## 标题\n\n第一行\n第二行 **粗**\n\n- 一\n- 二");

    // Assert
    expect(html).toContain("<h2>标题</h2>");
    expect(html).toContain("第一行<br>");
    expect(html).toContain("<strong>粗</strong>");
    expect(html).toContain("<li>一</li>");
  });

  it("draws the theme's image tag as an image with its caption, at a resolved address", () => {
    // Act
    const html = renderInstant("前文\n\n{% image /img/a.jpg, alt=桌面, width=400px %}\n\n后文", (u) => `http://127.0.0.1:4000${u}`);

    // Assert
    expect(html).toContain('<img src="http://127.0.0.1:4000/img/a.jpg" alt="桌面" style="width:400px">');
    expect(html).toContain("<figcaption>桌面</figcaption>");
    expect(html).not.toContain("{%");
  });

  it("boxes block tag plugins around their rendered content and labels single ones", () => {
    // Act
    const html = renderInstant("{% note info simple %}\n里面 **加粗**\n{% endnote %}\n\n点 {% btn /a, 按钮 %} 这里");

    // Assert
    expect(html).toContain('<div class="md-tag"><div class="md-tag-head">note info simple</div>');
    expect(html).toContain("<strong>加粗</strong>");
    expect(html).toContain('<span class="md-tag-inline">btn /a, 按钮</span>');
  });

  it("leaves tags inside fenced code as code", () => {
    // Act
    const html = renderInstant("```\n{% note %}x{% endnote %}\n```");

    // Assert
    expect(html).toContain("{% note %}x{% endnote %}");
    expect(html).not.toContain("md-tag");
  });
});
