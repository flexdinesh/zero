import type { FeedbackThread } from "@zero/contracts"

import { createFeedbackThread, uploadFeedbackAttachment } from "../../api/feedback-data.ts"
import type { ComposerCapture } from "../../lib/desktop-bridge.ts"
import { cropPNG, decodeBase64PNG, imageSize } from "../feedback/screen-image.ts"
import { capturePlan } from "./composer-model.ts"

const unreadable = "Couldn't read the page's screenshot. Pick again."

// sendComment posts a comment on a pick (decision 0184): it crops the
// captured frame to the selection and its margin, uploads the crop, then
// opens a visual thread on it in the project's feedback, with the page,
// the rectangle, and everything the page said of the element. It rejects
// with a message to show; nothing is posted twice, since the thread is the
// last request.
export async function sendComment(capture: ComposerCapture, body: string): Promise<FeedbackThread> {
  const frame = decodeBase64PNG(capture.png)
  if (!frame) throw new Error(unreadable)
  const size = await imageSize(frame).catch(() => null)
  if (!size) throw new Error(unreadable)
  const plan = capturePlan(capture, size)
  if (!plan?.page) throw new Error("The selection is outside what the page showed. Pick again.")
  const png = await cropPNG(frame, plan.clip)
  const upload = await uploadFeedbackAttachment(capture.project, png)
  return createFeedbackThread({
    project: capture.project,
    body,
    visual: { attachment: upload.id, rect: plan.rect, page: plan.page, ...(plan.element ? { element: plan.element } : {}) },
  })
}
