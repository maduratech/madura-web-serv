export type RoomSharingType = 'single' | 'twin' | 'triple' | 'quad';

export function sharingCapacity(type: RoomSharingType): number {
  switch (type) {
    case 'single':
      return 1;
    case 'twin':
      return 2;
    case 'triple':
      return 3;
    case 'quad':
      return 4;
    default:
      return 2;
  }
}
