import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderOutputBody } from ".";

describe("doc tool renderers", () => {
  it("links doc search result titles to the docs page", () => {
    render(
      <>
        {renderOutputBody(
          "doc.search",
          JSON.stringify({
            count: 1,
            items: [
              {
                project: {
                  id: "doc-123",
                  title: "Launch plan",
                  kind: "prd",
                  tags: ["release"],
                },
              },
            ],
          }),
        )}
      </>,
    );

    expect(screen.getByRole("link", { name: "Launch plan" })).toHaveAttribute(
      "href",
      "/docs/doc-123",
    );
  });

  it("links doc upsert results to the created doc", () => {
    render(
      <>
        {renderOutputBody(
          "doc.upsert",
          JSON.stringify({
            created: true,
            project: {
              id: "doc-created",
              title: "Research notes",
              kind: "note",
            },
          }),
        )}
      </>,
    );

    expect(screen.getByRole("link", { name: "Research notes" })).toHaveAttribute(
      "href",
      "/docs/doc-created",
    );
  });
});
