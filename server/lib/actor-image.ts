import 'multer'
import { queue } from 'async'
import * as LRUCache from 'lru-cache'
import { extname, join } from 'path'
import { v4 as uuidv4 } from 'uuid'
import { ActorImageType } from '@shared/models'
import { retryTransactionWrapper } from '../helpers/database-utils'
import { processImage } from '../helpers/image-utils'
import { downloadImage } from '../helpers/requests'
import { CONFIG } from '../initializers/config'
import { ACTOR_IMAGES_SIZE, LRU_CACHE, QUEUE_CONCURRENCY } from '../initializers/constants'
import { sequelizeTypescript } from '../initializers/database'
import { MAccountDefault, MChannelDefault } from '../types/models'
import { deleteActorImageInstance, updateActorImageInstance } from './activitypub/actor'
import { sendUpdateActor } from './activitypub/send'

async function updateLocalActorImageFile (
  accountOrChannel: MAccountDefault | MChannelDefault,
  imagePhysicalFile: Express.Multer.File,
  type: ActorImageType
) {
  const imageSize = type === ActorImageType.AVATAR
    ? ACTOR_IMAGES_SIZE.AVATARS
    : ACTOR_IMAGES_SIZE.BANNERS

  const extension = extname(imagePhysicalFile.filename)

  const imageName = uuidv4() + extension
  const destination = join(CONFIG.STORAGE.ACTOR_IMAGES, imageName)
  await processImage(imagePhysicalFile.path, destination, imageSize)

  return retryTransactionWrapper(() => {
    return sequelizeTypescript.transaction(async t => {
      const actorImageInfo = {
        name: imageName,
        fileUrl: null,
        height: imageSize.height,
        width: imageSize.width,
        onDisk: true
      }

      const updatedActor = await updateActorImageInstance(accountOrChannel.Actor, type, actorImageInfo, t)
      await updatedActor.save({ transaction: t })

      await sendUpdateActor(accountOrChannel, t)

      return type === ActorImageType.AVATAR
        ? updatedActor.Avatar
        : updatedActor.Banner
    })
  })
}

async function deleteLocalActorImageFile (accountOrChannel: MAccountDefault | MChannelDefault, type: ActorImageType) {
  return retryTransactionWrapper(() => {
    return sequelizeTypescript.transaction(async t => {
      const updatedActor = await deleteActorImageInstance(accountOrChannel.Actor, type, t)
      await updatedActor.save({ transaction: t })

      await sendUpdateActor(accountOrChannel, t)

      return updatedActor.Avatar
    })
  })
}

type DownloadImageQueueTask = { fileUrl: string, filename: string, type: ActorImageType }

const downloadImageQueue = queue<DownloadImageQueueTask, Error>((task, cb) => {
  const size = task.type === ActorImageType.AVATAR
    ? ACTOR_IMAGES_SIZE.AVATARS
    : ACTOR_IMAGES_SIZE.BANNERS

  downloadImage(task.fileUrl, CONFIG.STORAGE.ACTOR_IMAGES, task.filename, size)
    .then(() => cb())
    .catch(err => cb(err))
}, QUEUE_CONCURRENCY.ACTOR_PROCESS_IMAGE)

function pushActorImageProcessInQueue (task: DownloadImageQueueTask) {
  return new Promise<void>((res, rej) => {
    downloadImageQueue.push(task, err => {
      if (err) return rej(err)

      return res()
    })
  })
}

// Unsafe so could returns paths that does not exist anymore
const actorImagePathUnsafeCache = new LRUCache<string, string>({ max: LRU_CACHE.ACTOR_IMAGE_STATIC.MAX_SIZE })

export {
  actorImagePathUnsafeCache,
  updateLocalActorImageFile,
  deleteLocalActorImageFile,
  pushActorImageProcessInQueue
}
