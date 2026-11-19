import { describe, expect, it } from "vitest";
import {
  isAudioCloudinaryUploadFromFolder,
  cloudinaryPublicIdFromUrl,
  cloudinarySignature,
} from "./cloudinary.js";

describe("Cloudinary upload signing", () => {
  it("signs the canonical sorted upload parameters", () => {
    expect(
      cloudinarySignature(
        {
          timestamp: 1_700_000_000,
          folder: "sanctyria/users/u/profile",
          overwrite: false,
        },
        "secret",
      ),
    ).toBe("2e6affd53085442f477b3d45240ce2cb6132e2ba");
  });
});

describe("Cloudinary public ID parsing", () => {
  it("extracts a versioned video asset from the expected folder", () => {
    expect(
      cloudinaryPublicIdFromUrl(
        "https://res.cloudinary.com/demo/video/upload/v123/sanctyria/users/u/replies/id.mp4",
        "demo",
        "sanctyria/users/u/replies",
      ),
    ).toEqual({
      publicId: "sanctyria/users/u/replies/id",
      resourceType: "video",
    });
  });

  describe("Cloudinary audio upload validation", () => {
    it("accepts signed audio uploads returned with an mp4 extension", () => {
      expect(
        isAudioCloudinaryUploadFromFolder(
          "https://res.cloudinary.com/demo/video/upload/v123/sanctyria/users/u/posts/c/audio.mp4",
          "demo",
          "sanctyria/users/u/posts/c",
        ),
      ).toBe(true);
    });

    it("keeps audio uploads restricted to the signed video resource and folder", () => {
      expect(
        isAudioCloudinaryUploadFromFolder(
          "https://res.cloudinary.com/demo/video/upload/sanctyria/users/u/posts/other/audio.m4a",
          "demo",
          "sanctyria/users/u/posts/c",
        ),
      ).toBe(false);
      expect(
        isAudioCloudinaryUploadFromFolder(
          "https://res.cloudinary.com/demo/image/upload/sanctyria/users/u/posts/c/audio.m4a",
          "demo",
          "sanctyria/users/u/posts/c",
        ),
      ).toBe(false);
    });
  });

  it("does not accept URLs outside the expected folder", () => {
    expect(
      cloudinaryPublicIdFromUrl(
        "https://res.cloudinary.com/demo/image/upload/sanctyria/users/other/profile/id.jpg",
        "demo",
        "sanctyria/users/u/profile",
      ),
    ).toBeNull();
    expect(
      cloudinaryPublicIdFromUrl(
        "https://attacker.example/demo/image/upload/sanctyria/users/u/profile/id.jpg",
        "demo",
        "sanctyria/users/u/profile",
      ),
    ).toBeNull();
  });
});
