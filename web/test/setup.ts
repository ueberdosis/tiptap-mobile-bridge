// jsdom has no layout, but ProseMirror measures a Range whenever it scrolls the selection into view.
Range.prototype.getClientRects = () => [] as unknown as DOMRectList
Range.prototype.getBoundingClientRect = () => new DOMRect()
