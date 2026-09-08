// Reusable wrapper around the Microsoft Store submission API.
// Reference: https://learn.microsoft.com/en-us/windows/uwp/monetize/manage-app-submissions
//            https://learn.microsoft.com/en-us/windows/uwp/monetize/get-app-data
//
// Using this API costs nothing beyond the Partner Center developer account
// you already have — Azure AD tokens and the REST calls themselves are free.

import fs from "node:fs";
import path from "node:path";
import archiver from "archiver";
import { getAccessToken } from "./auth.js";

const BASE_URL = "https://manage.devcenter.microsoft.com/v1.0/my/applications";

export class StoreSubmissionClient {
  /**
   * @param {object} creds
   * @param {string} creds.tenantId
   * @param {string} creds.clientId
   * @param {string} creds.clientSecret
   */
  constructor(creds) {
    this.creds = creds;
  }

  async _authHeaders(extra = {}) {
    const token = await getAccessToken(this.creds);
    return {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...extra,
    };
  }

  async _request(method, url, { body, headers } = {}) {
    const res = await fetch(url, {
      method,
      headers: { ...(await this._authHeaders()), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    const json = text ? JSON.parse(text) : null;

    if (!res.ok) {
      const err = new Error(
        `Store API ${method} ${url} failed: ${res.status} ${res.statusText}`
      );
      err.status = res.status;
      err.body = json ?? text;
      throw err;
    }
    return json;
  }

  // ---- Apps -------------------------------------------------------------

  /** List every app in the Partner Center account. */
  listApplications() {
    return this._request("GET", BASE_URL);
  }

  /** Get one app's data (includes pending/last-published submission ids). */
  getApplication(storeId) {
    return this._request("GET", `${BASE_URL}/${storeId}`);
  }

  // ---- Submissions --------------------------------------------------------

  /**
   * Creates a new in-progress submission (a copy of the last published
   * submission). Returns the submission resource, including
   * `fileUploadUrl` (an Azure Blob SAS URL) used to upload packages/images.
   */
  createSubmission(storeId) {
    return this._request("POST", `${BASE_URL}/${storeId}/submissions`);
  }

  /** Fetch an existing submission by id. */
  getSubmission(storeId, submissionId) {
    return this._request(
      "GET",
      `${BASE_URL}/${storeId}/submissions/${submissionId}`
    );
  }

  /**
   * Replaces the submission's data (listings, pricing, packages, etc).
   * Pass the full submission object (typically what you got from
   * createSubmission/getSubmission, with your edits applied).
   */
  updateSubmission(storeId, submissionId, submissionData) {
    return this._request(
      "PUT",
      `${BASE_URL}/${storeId}/submissions/${submissionId}`,
      { body: submissionData }
    );
  }

  /** Commits the submission, sending it to the Store for ingestion. */
  commitSubmission(storeId, submissionId) {
    return this._request(
      "POST",
      `${BASE_URL}/${storeId}/submissions/${submissionId}/commit`
    );
  }

  /** Polls the processing status of a submission (CommitStarted, Certification, Published, ...). */
  getSubmissionStatus(storeId, submissionId) {
    return this._request(
      "GET",
      `${BASE_URL}/${storeId}/submissions/${submissionId}/status`
    );
  }

  /** Deletes an in-progress submission (cannot delete a published one). */
  deleteSubmission(storeId, submissionId) {
    return this._request(
      "DELETE",
      `${BASE_URL}/${storeId}/submissions/${submissionId}`
    );
  }

  /**
   * Polls getSubmissionStatus until it leaves the "in progress" states,
   * or until timeoutMs elapses. Returns the final status resource.
   */
  async waitForStatus(
    storeId,
    submissionId,
    { intervalMs = 30_000, timeoutMs = 30 * 60_000 } = {}
  ) {
    const inProgress = new Set(["None", "CommitStarted", "PreProcessing"]);
    const start = Date.now();
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const status = await this.getSubmissionStatus(storeId, submissionId);
      if (!inProgress.has(status.status)) return status;
      if (Date.now() - start > timeoutMs) {
        throw new Error(
          `Timed out waiting for submission ${submissionId} to leave state ${status.status}`
        );
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  // ---- File upload (packages, screenshots, etc.) -------------------------

  /**
   * Zips the given files (array of absolute paths, or {path, nameInZip})
   * and uploads the zip to the submission's fileUploadUrl (an Azure Blob
   * SAS URL). Uses a single-shot PUT Blob request, which supports blobs up
   * to 256 MB — fine for most app packages/images. For larger packages,
   * switch to the @azure/storage-blob SDK's block-upload APIs instead.
   */
  async zipAndUploadFiles(fileUploadUrl, files, zipOutputPath) {
    await this._zipFiles(files, zipOutputPath);
    await this._uploadBlockBlob(fileUploadUrl, zipOutputPath);
  }

  _zipFiles(files, zipOutputPath) {
    return new Promise((resolve, reject) => {
      const output = fs.createWriteStream(zipOutputPath);
      const archive = archiver("zip", { zlib: { level: 9 } });

      output.on("close", resolve);
      archive.on("error", reject);
      archive.pipe(output);

      for (const f of files) {
        const filePath = typeof f === "string" ? f : f.path;
        const nameInZip =
          typeof f === "string" ? path.basename(f) : f.nameInZip ?? path.basename(f.path);
        archive.file(filePath, { name: nameInZip });
      }

      archive.finalize();
    });
  }

  async _uploadBlockBlob(sasUrl, filePath) {
    const data = await fs.promises.readFile(filePath);
    const res = await fetch(sasUrl, {
      method: "PUT",
      headers: {
        "x-ms-blob-type": "BlockBlob",
        "Content-Length": String(data.length),
      },
      body: data,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Blob upload failed: ${res.status} ${res.statusText} ${text}`
      );
    }
  }
}
