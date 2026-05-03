import type { FrameRecord } from "./types";
import { parseFigmaUrl, withNodeId } from "./utils/url";

export const OZ_MOBILE_REGISTRATION_BOARD_FILE_KEY = "7HszZb9F00XXRAAR9LGIVr";
export const OZ_MOBILE_REGISTRATION_BOARD_NODE_ID = "415:634";

export const OZ_MOBILE_REGISTRATION_REQUIRED_SCREENS = [
  {
    nodeId: "2255:4732",
    name: "Splash screen",
    expectedScreenText: "OZ",
  },
  {
    nodeId: "433:4056",
    name: "onboarding/1",
  },
  {
    nodeId: "433:5749",
    name: "on boarding -- Light Mode -- oz knowledge",
  },
  {
    nodeId: "433:5958",
    name: "on boarding -- Light Mode -- oz fitness",
  },
  {
    nodeId: "469:1090",
    name: "Registration - light mode - log in",
  },
  {
    nodeId: "1746:36440",
    name: "Registration - light mode - log in",
    expectedScreenText: "Connection lost",
  },
  {
    nodeId: "469:12126",
    name: "Registration - light mode - log in - error",
  },
  {
    nodeId: "1711:73147",
    name: "Registration - light mode - log in/error",
    expectedScreenText: "Connection Lost",
  },
  {
    nodeId: "469:13119",
    name: "Registration - light mode - loin/ forget password",
  },
  {
    nodeId: "469:14248",
    name: "Registration - light mode - loin/ forget password/otp",
  },
  {
    nodeId: "469:14336",
    name: "Registration - light mode - loin/ forget password/create new",
  },
  {
    nodeId: "2008:31009",
    name: "Registration - light mode - loin/ forget password/create new /error",
  },
  {
    nodeId: "509:16534",
    name: "Registration - light mode - loin/ forget password/suucess pop up",
  },
  {
    nodeId: "509:17116",
    name: "failed",
  },
  {
    nodeId: "509:19354",
    name: "Registration - light mode - sign up/basic info",
  },
  {
    nodeId: "1695:71973",
    name: "Registration - light mode - sign up/basic info/sign in with google/apple",
  },
  {
    nodeId: "2255:4962",
    name: "Registration - light mode - sign up/basic info",
  },
  {
    nodeId: "509:19647",
    name: "Registration - light mode - sign up/company info",
  },
  {
    nodeId: "1695:72316",
    name: "Registration - light mode - sign up/company info",
  },
  {
    nodeId: "509:19822",
    name: "Registration - light mode - sign up/intreset",
  },
  {
    nodeId: "1695:72468",
    name: "Registration - light mode - sign up/intreset",
  },
  {
    nodeId: "3026:47100",
    name: "Registration - light mode - sign up/intreset",
  },
  {
    nodeId: "509:19936",
    name: "Registration - light mode - sign up/otp",
  },
  {
    nodeId: "1695:72183",
    name: "Registration - light mode - sign up/otp",
  },
  {
    nodeId: "544:21107",
    name: "OTP Error",
  },
  {
    nodeId: "1695:72245",
    name: "OTP Error",
  },
  {
    nodeId: "2008:30661",
    name: "Registration - light mode - sign up/terms of service",
  },
  {
    nodeId: "2774:16032",
    name: "Registration - light mode - sign up/terms of service pop up",
  },
  {
    nodeId: "2774:16460",
    name: "Registration - light mode - sign up / onboarding",
  },
  {
    nodeId: "2774:16486",
    name: "Registration - light mode - sign up / onboarding /q1",
  },
  {
    nodeId: "2774:16573",
    name: "Registration - light mode - sign up / onboarding /q2",
  },
  {
    nodeId: "2774:16661",
    name: "Registration - light mode - sign up / onboarding /q3",
  },
  {
    nodeId: "2774:16755",
    name: "Registration - light mode - sign up / onboarding /q4",
  },
  {
    nodeId: "2774:16838",
    name: "Registration - light mode - sign up / onboarding /q5",
  },
  {
    nodeId: "2774:16921",
    name: "Registration - light mode - sign up / onboarding /q6",
  },
  {
    nodeId: "2774:17004",
    name: "Registration - light mode - sign up / onboarding /q7",
  },
  {
    nodeId: "2774:17092",
    name: "Registration - light mode - sign up / onboarding /q8",
  },
  {
    nodeId: "2774:17175",
    name: "Registration - light mode - sign up / onboarding /q9",
  },
  {
    nodeId: "2774:17258",
    name: "Registration - light mode - sign up / onboarding /q10",
  },
  {
    nodeId: "2774:17341",
    name: "Registration - light mode - sign up / onboarding /loding",
    expectedScreenText: "Finding your rhythm",
  },
  {
    nodeId: "2774:17349",
    name: "Registration - light mode - sign up / onboarding /Results/BUILDER",
    expectedScreenText: "Builder",
  },
  {
    nodeId: "2774:17378",
    name: "Registration - light mode - sign up / onboarding /Results/connetor",
    expectedScreenText: "Connector",
  },
  {
    nodeId: "2774:17407",
    name: "Registration - light mode - sign up / onboarding /Results/learner",
    expectedScreenText: "Learner",
  },
  {
    nodeId: "2774:17436",
    name: "Registration - light mode - sign up / onboarding /Results/focuser",
    expectedScreenText: "Focuser",
  },
  {
    nodeId: "2774:17465",
    name: "Registration - light mode - sign up / onboarding /Results/explored",
    expectedScreenText: "Explorer",
  },
] as const;

export function requiredKnownFramesForUrl(figmaUrl: string): FrameRecord[] {
  const parsed = parseFigmaUrl(figmaUrl);
  if (
    parsed.fileKey !== OZ_MOBILE_REGISTRATION_BOARD_FILE_KEY ||
    parsed.nodeId !== OZ_MOBILE_REGISTRATION_BOARD_NODE_ID
  ) {
    return [];
  }

  return OZ_MOBILE_REGISTRATION_REQUIRED_SCREENS.map((screen) => ({
    nodeId: screen.nodeId,
    name: screen.name,
    source: "manual",
    url: withNodeId(figmaUrl, screen.nodeId),
  }));
}

export function appendMissingRequiredKnownFrames(
  figmaUrl: string,
  frames: FrameRecord[],
): { frames: FrameRecord[]; added: FrameRecord[] } {
  const knownFrames = requiredKnownFramesForUrl(figmaUrl);
  if (knownFrames.length === 0) return { frames, added: [] };

  const seen = new Set(frames.map((frame) => frame.nodeId));
  const added = knownFrames.filter((frame) => !seen.has(frame.nodeId));
  return { frames: [...frames, ...added], added };
}
