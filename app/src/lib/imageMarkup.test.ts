import { describe, expect, it } from "vitest";
import { findImages, imageAt, newImage, renderImage, restyle } from "./imageMarkup";

const URL = "https://hexo-image-storage.oss-cn-shanghai.aliyuncs.com/EverettBlog/3f9a1c07b2e4.webp";

describe("reading images", () => {
  it("reads the image tag the way the theme does", () => {
    // Act
    const [img] = findImages(`{% image ${URL}, width=400px, alt=此图中的全部信息均为示例，密码没有任何参考价值 %}`);

    // Assert
    expect(img).toMatchObject({ style: "image", url: URL, width: "400px", alt: "此图中的全部信息均为示例，密码没有任何参考价值", height: "", bg: "", block: true });
  });

  it("reads Markdown with markdown-it-imsize sizes as CSS lengths", () => {
    // Act
    const [a, b] = findImages(`![猫](${URL} =300x) and ![](<a b.png> =x50% "t")`);

    // Assert
    expect(a).toMatchObject({ style: "markdown", alt: "猫", url: URL, width: "300px", height: "", block: false });
    expect(b).toMatchObject({ url: "a b.png", width: "", height: "50%", title: "t" });
  });

  it("reads both inline tags", () => {
    // Act
    const found = findImages(`这是 {% inlineimage ${URL}, height=40px %} 一段，{% inlineImg ${URL} 150px %}`);

    // Assert
    expect(found.map((f) => [f.style, f.height, f.block])).toEqual([
      ["inlineimage", "40px", false],
      ["inlineImg", "150px", false],
    ]);
  });

  it("gives the exact range of each image", () => {
    // Arrange
    const tag = `{% image ${URL} %}`;
    const text = `前文\n${tag}\n后文`;

    // Act
    const [img] = findImages(text);

    // Assert
    expect(text.slice(img.from, img.to)).toBe(tag);
    expect(imageAt(text, img.from + 5)?.url).toBe(URL);
    expect(imageAt(text, img.to)).toBeNull();
  });

  it("skips images shown inside fenced code and other tags", () => {
    // Arrange
    const text = "```markdown\n{% image a.webp, width=400px %}\n![](b.png)\n```\n{% note info %}x{% endnote %}\n![](c.png)";

    // Act
    const found = findImages(text);

    // Assert
    expect(found.map((f) => f.url)).toEqual(["c.png"]);
  });

  it("keeps tag arguments it has no control for", () => {
    // Act
    const [img] = findImages(`{% image ${URL}, width=50%, lazy=no %}`);

    // Assert
    expect(img.extra).toEqual(["lazy=no"]);
    expect(renderImage(img)).toBe(`{% image ${URL}, width=50%, lazy=no %}`);
  });
});

describe("writing images", () => {
  it("writes back what it read, unchanged", () => {
    // Arrange
    const samples = [
      `{% image ${URL}, width=700px, alt=这里使用刚刚创建的 alice 用户进行 POST 登录请求 %}`,
      `{% image ${URL}, width=400px, bg=#1D0C04, alt=优化不同宽度浏览的观感 %}`,
      `{% image ${URL} %}`,
      `![图](${URL} =300x200)`,
      `{% inlineimage ${URL}, height=40px %}`,
      `{% inlineImg ${URL} 150px %}`,
    ];

    // Act
    const written = samples.map((s) => renderImage(findImages(s)[0]));

    // Assert
    expect(written).toEqual(samples);
  });

  it("keeps a value from splitting the theme's arguments or ending the tag", () => {
    // Arrange
    const [img] = findImages(`{% image ${URL} %}`);

    // Act
    const text = renderImage({ ...img, alt: "左, 右 %} 完" });

    // Assert
    expect(findImages(text)[0].alt).toBe("左，右 % 完");
  });

  it("leaves out a size Markdown cannot hold", () => {
    // Arrange
    const [img] = findImages(`{% image ${URL}, width=2em, height=300px %}`);

    // Act
    const md = renderImage(restyle(img, "markdown"));

    // Assert
    expect(md).toBe(`![](${URL} =x300)`);
  });

  it("carries width, height and caption across styles, but not another tag's arguments", () => {
    // Arrange
    const [img] = findImages(`![说明](${URL} =500x "t")`);

    // Act
    const tag = renderImage(restyle(img, "image"));
    const inline = renderImage(restyle({ ...img, extra: ["x"] }, "inlineimage"));

    // Assert
    expect(tag).toBe(`{% image ${URL}, width=500px, alt=说明 %}`);
    expect(inline).toBe(`{% inlineimage ${URL} %}`);
  });

  it("starts a new image with nothing but its address", () => {
    // Act / Assert
    expect(newImage(URL, "image")).toBe(`{% image ${URL} %}`);
    expect(newImage(URL, "markdown")).toBe(`![](${URL})`);
  });
});
