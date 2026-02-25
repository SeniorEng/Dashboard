import DOMPurify from "dompurify";

const SANITIZE_CONFIG = {
  ALLOWED_TAGS: ['html','head','body','style','h1','h2','h3','h4','h5','h6','p','br','strong','em','ul','ol','li','table','tr','td','th','thead','tbody','tfoot','caption','colgroup','col','img','div','span','hr','b','i','u','a','header','footer','section','nav','main','article','aside','figure','figcaption','blockquote','pre','code','dl','dt','dd','meta','title','label','input'],
  ALLOWED_ATTR: ['class','style','src','alt','width','height','colspan','rowspan','href','id','lang','charset','name','content','type','for','value','placeholder','readonly'],
};

interface DocumentPreviewProps {
  html: string;
  isFullHtmlDocument?: boolean;
  className?: string;
}

export function DocumentPreview({ html, isFullHtmlDocument, className }: DocumentPreviewProps) {
  const isFullDoc = isFullHtmlDocument ?? (html.trimStart().startsWith("<!DOCTYPE") || html.trimStart().startsWith("<html"));

  if (isFullDoc) {
    return (
      <div className={className ?? "border rounded-lg bg-white overflow-hidden"} style={{ height: "50vh" }}>
        <iframe
          srcDoc={html}
          className="w-full h-full border-0"
          sandbox="allow-same-origin"
          title="Dokumentenvorschau"
          data-testid="preview-rendered-document"
        />
      </div>
    );
  }

  return (
    <div className={className ?? "border rounded-lg p-4 sm:p-6 bg-white max-h-[50vh] overflow-y-auto"}>
      <div
        className="prose prose-sm max-w-none"
        dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(html, SANITIZE_CONFIG) }}
        data-testid="preview-rendered-document"
      />
    </div>
  );
}
