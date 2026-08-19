/// <reference types="vite/client" />

/** True only in the review build (vite.config.review.ts): explore map, no story. */
declare const __REVIEW__: boolean;

/** Whether the story deck was built, so nothing links to a page that is absent. */
declare const __STORY__: boolean;
