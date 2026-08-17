/** Render the Vue 3 + Element Plus application shell. Assets are bundled into dist/web. */
export declare function renderWebUi(mountPath?: string): string;
export declare function webAsset(name: 'app.js' | 'app.css'): {
    content: string;
    contentType: string;
};
