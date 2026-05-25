export type RoomSharingType = 'single' | 'twin' | 'triple';

export function sharingCapacity(type: RoomSharingType): number {
  switch (type) {
    case 'single':
      return 1;
    case 'twin':
      return 2;
    case 'triple':
      return 3;
    default:
      return 2;
  }
}
